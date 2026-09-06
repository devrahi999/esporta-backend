import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { PostsService } from '../posts/posts.service';
import { RecommendationService } from '../recommendation/recommendation.service';
import { clampLimit } from '../common/dto/pagination.dto';
import { blockedIdentityIds, inList } from '../common/db/blocks.util';

// Kept in lock-step with the Flutter IdentityRepository selects so the app's
// `Player`/`Team` mappers consume these rows unchanged (migration Phase 3).
//
// `following_count` goes through the `visible_following_count` computed column,
// so a search result cannot become the back door to a count the profile hid.
const IDENTITY_COLUMNS =
  'id, kind, username, display_name, avatar_url, cover_url, bio, country, city, ' +
  ' verified, created_at, followers_count, ' +
  'following_count:visible_following_count, following_count_visible';

// The team a person is currently on — a left join (a player may have none), so
// NOT `!inner`. Matches the app's `_membershipEmbed`.
const MEMBERSHIP_EMBED =
  'team_members!team_members_identity_id_fkey(status, team_id, ' +
  'teams!team_members_team_id_fkey(tag, primary_game_id, ' +
  'identities!teams_id_fkey(display_name, username, avatar_url)))';

// The team card's fields, matching the app's `_teamEmbed`.
const TEAM_EMBED =
  'teams!teams_id_fkey!inner(tag, primary_game_id, region, recruiting, founded, ' +
  'members_count, owner_id, socials, ' +
  'team_games(game_id, is_primary), ' +
  'team_achievements(title, placement, year, sort_order))';

// `profiles!inner` always (every personal identity has a profile row); the game
// list becomes an inner join only when a game/sub-role filter is applied, so the
// filter narrows the parent rather than returning an empty embed.
function profileEmbed(innerGames: boolean): string {
  return (
    'profiles!inner(primary_role_id, availability, socials, profile_views, ' +
    `user_games${innerGames ? '!inner' : ''}(game_id, ign, role, rank, is_primary))`
  );
}

// Mirrors the app's IdentityOrder. Only used when browsing (no text query);
// a text query is ranked by relevance instead.
function orderColumn(order?: string): string {
  switch (order) {
    case 'recentlyActive':
      return 'updated_at';
    case 'newest':
      return 'created_at';
    default:
      return 'followers_count';
  }
}

export interface ProfileSearchParams {
  q?: string;
  limit?: number;
  gameId?: string;
  gameRoleSlug?: string;
  roleId?: string;
  availability?: string;
  verifiedOnly?: boolean;
  order?: string;
}

export interface TeamSearchParams {
  q?: string;
  limit?: number;
  gameId?: string;
  /**
   * `team_categories.id` — `esports_team`, `news_media`, `tournament_organizer`.
   *
   * The app's Search tab covers every non-personal profile, not just rosters, so
   * it needs to narrow to one type. Values are not validated against the table
   * here: an unknown id simply matches nothing, and `team_categories` stays the
   * authority on what exists — an inactive row like `esports_org` never reaches
   * a client through `/lookups`, so it cannot be offered as a filter.
   */
  categoryId?: string;
  recruitingOnly?: boolean;
  verifiedOnly?: boolean;
  order?: string;
}

type Row = Record<string, unknown> & { id: string };

/**
 * Unified search backed by the DB ranking RPCs (`search_identity_ids`,
 * `search_post_ids`) — trigram + edit-distance, typo tolerant. A text query
 * ranks ids and we hydrate + preserve that order; an empty query is a filtered
 * "browse" ordered by the requested column. Filters, ordering and block
 * exclusion mirror the app's IdentityRepository exactly, so one backend gives
 * identical results on every platform (plan §27).
 */
@Injectable()
export class SearchService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly posts: PostsService,
    private readonly recommendations: RecommendationService,
  ) {}

  async profiles(token: string, viewerId: string, params: ProfileSearchParams): Promise<Row[]> {
    const max = clampLimit(params.limit, 40, 50);
    const needsGameJoin = !!params.gameId || !!params.gameRoleSlug;
    const select = `${IDENTITY_COLUMNS}, ${profileEmbed(needsGameJoin)}, ${MEMBERSHIP_EMBED}`;

    const lexical = await this.rankedIdsWithScore(token, params.q, 'personal', max);
    if (lexical && lexical.length === 0) return [];

    const client = this.supabase.asCaller(token);
    let req = client
      .from('identities')
      .select(select)
      .eq('kind', 'personal')
      .eq('status', 'active');

    if (lexical) req = req.in('id', lexical.map((r) => r.id));
    const blocked = await blockedIdentityIds(this.supabase, token);
    if (blocked.length) req = req.not('id', 'in', inList(blocked));
    if (params.verifiedOnly) req = req.eq('verified', true);
    if (params.availability) req = req.eq('profiles.availability', params.availability);
    if (params.roleId) req = req.eq('profiles.primary_role_id', params.roleId);
    if (params.gameId) req = req.eq('profiles.user_games.game_id', params.gameId);
    if (params.gameRoleSlug) req = req.eq('profiles.user_games.role', params.gameRoleSlug);

    const ordered = lexical
      ? req.limit(max)
      : req.order(orderColumn(params.order), { ascending: false }).limit(max);
    const rows = await this.supabase.run<Row[]>(ordered);
    if (!lexical) return rows;

    // Re-order the HYDRATED rows by the ranked order, so identities RLS filtered
    // out of hydration simply drop rather than shifting the ranked sequence —
    // the same fail-closed pattern as post search's byIds.
    const rankedOrder = await this.identityRankedOrder(
      token,
      viewerId,
      lexical,
    );
    const hydratedOrder = rankedOrder ?? lexical.map((r) => r.id);
    return this.inRankedOrder(rows, hydratedOrder);
  }

  async teams(token: string, viewerId: string, params: TeamSearchParams): Promise<Row[]> {
    const max = clampLimit(params.limit, 40, 50);
    const select = `${IDENTITY_COLUMNS}, ${TEAM_EMBED}`;

    const lexical = await this.rankedIdsWithScore(token, params.q, 'team', max);
    if (lexical && lexical.length === 0) return [];

    const client = this.supabase.asCaller(token);
    let req = client
      .from('identities')
      .select(select)
      .eq('kind', 'team')
      .eq('status', 'active');

    if (lexical) req = req.in('id', lexical.map((r) => r.id));
    const blocked = await blockedIdentityIds(this.supabase, token);
    if (blocked.length) req = req.not('id', 'in', inList(blocked));
    if (params.verifiedOnly) req = req.eq('verified', true);
    if (params.categoryId) req = req.eq('teams.category_id', params.categoryId);
    if (params.gameId) req = req.eq('teams.primary_game_id', params.gameId);
    if (params.recruitingOnly) req = req.eq('teams.recruiting', 'open');

    const ordered = lexical
      ? req.limit(max)
      : req.order(orderColumn(params.order), { ascending: false }).limit(max);
    const rows = await this.supabase.run<Row[]>(ordered);
    if (!lexical) return rows;

    const rankedOrder = await this.identityRankedOrder(token, viewerId, lexical);
    const hydratedOrder = rankedOrder ?? lexical.map((r) => r.id);
    return this.inRankedOrder(rows, hydratedOrder);
  }

  /**
   * The bounded personalised re-ordering for identity search, shared by profiles
   * and teams. Returns null when ranking did not produce an ordering (disabled,
   * failure, empty) — the caller then keeps the lexical order, which is the
   * pre-ranking behaviour, not an error.
   *
   * Query relevance stays dominant BY CONSTRUCTION: the ranker only re-orders
   * the lexical result set, and relevance multiplies the whole score.
   */
  private async identityRankedOrder(
    _token: string,
    viewerId: string,
    lexical: Array<{ id: string; score: number }>,
  ): Promise<string[] | null> {
    const slate = await this.recommendations.rankIdentitySearch({
      viewerId,
      relevance: new Map(lexical.map((r) => [r.id, r.score])),
      identityIds: lexical.map((r) => r.id),
    });
    if (slate.fallback || slate.rankedIds.length === 0) return null;
    return slate.rankedIds;
  }

  /**
   * Post search: lexical relevance first, then a bounded personalised re-rank.
   *
   * `search_post_ids` returns `(id, score)` and the score used to be discarded —
   * so a typo match and an exact caption match arrived indistinguishable, and the
   * only ordering left was whatever came back. It is now carried into the ranker
   * as a MULTIPLICATIVE GATE, which is what keeps §12 true: an exact match cannot
   * be pushed below a weakly-related but popular or familiar entity, because
   * relevance scales the whole score rather than adding to it.
   *
   * Ranking is restricted to the lexical result set — search never generates
   * candidates of its own, so it cannot drift into being a recommendation feed.
   * If ranking is disabled or fails, the original relevance order is served
   * unchanged.
   */
  async postsSearch(token: string, viewerId: string, q: string, limit?: number): Promise<unknown[]> {
    const max = clampLimit(limit, 20, 50);
    const rows = await this.supabase.rpcAsCaller<Array<{ id: string; score: number | string }>>(
      token,
      'search_post_ids',
      { q, max_rows: max },
    );
    const matches = rows ?? [];
    if (matches.length === 0) return [];

    const relevanceOrder = matches.map((r) => r.id);
    const relevance = new Map(
      matches.map((r) => [r.id, typeof r.score === 'number' ? r.score : Number(r.score) || 0]),
    );

    const slate = await this.recommendations.rank({
      viewerId,
      surface: 'search',
      limit: max,
      relevance,
      restrictTo: relevanceOrder,
    });

    const ids = slate.fallback || slate.postIds.length === 0 ? relevanceOrder : slate.postIds;
    return this.posts.byIds(token, viewerId, ids);
  }

  /**
   * Lexical matches WITH their relevance scores for a text query, or null when
   * the query is empty (browse mode — the caller orders by column instead).
   *
   * The score used to be discarded here, so a typo match and an exact match were
   * indistinguishable to the re-ranker. It is now carried through to the ranker,
   * which multiplies the whole personalised score by it — the same fix post
   * search received.
   */
  private async rankedIdsWithScore(
    token: string,
    q: string | undefined,
    targetKind: 'personal' | 'team',
    max: number,
  ): Promise<Array<{ id: string; score: number }> | null> {
    const query = (q ?? '').trim();
    if (!query) return null;
    const ranked = await this.supabase.rpcAsCaller<
      Array<{ id: string; score: number | string }> | null
    >(token, 'search_identity_ids', {
      q: query,
      target_kind: targetKind,
      max_rows: max,
    });
    return (ranked ?? []).map((r) => ({
      id: r.id,
      score: typeof r.score === 'number' ? r.score : Number(r.score) || 0,
    }));
  }

  /** Restores the ranker's relevance order (PostgREST cannot sort by id list). */
  private inRankedOrder(rows: Row[], ids: string[]): Row[] {
    const order = new Map(ids.map((id, i) => [id, i]));
    return [...rows].sort((a, b) => (order.get(a.id) ?? ids.length) - (order.get(b.id) ?? ids.length));
  }
}

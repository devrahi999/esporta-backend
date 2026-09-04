import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { PostsService } from '../posts/posts.service';
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
  ) {}

  async profiles(token: string, params: ProfileSearchParams): Promise<Row[]> {
    const max = clampLimit(params.limit, 40, 50);
    const needsGameJoin = !!params.gameId || !!params.gameRoleSlug;
    const select = `${IDENTITY_COLUMNS}, ${profileEmbed(needsGameJoin)}, ${MEMBERSHIP_EMBED}`;

    const rankedIds = await this.rankedIds(token, params.q, 'personal', max);
    if (rankedIds && rankedIds.length === 0) return [];

    const client = this.supabase.asCaller(token);
    let req = client
      .from('identities')
      .select(select)
      .eq('kind', 'personal')
      .eq('status', 'active');

    if (rankedIds) req = req.in('id', rankedIds);
    const blocked = await blockedIdentityIds(this.supabase, token);
    if (blocked.length) req = req.not('id', 'in', inList(blocked));
    if (params.verifiedOnly) req = req.eq('verified', true);
    if (params.availability) req = req.eq('profiles.availability', params.availability);
    if (params.roleId) req = req.eq('profiles.primary_role_id', params.roleId);
    if (params.gameId) req = req.eq('profiles.user_games.game_id', params.gameId);
    if (params.gameRoleSlug) req = req.eq('profiles.user_games.role', params.gameRoleSlug);

    const ordered = rankedIds
      ? req.limit(max)
      : req.order(orderColumn(params.order), { ascending: false }).limit(max);
    const rows = await this.supabase.run<Row[]>(ordered);
    return rankedIds ? this.inRankedOrder(rows, rankedIds) : rows;
  }

  async teams(token: string, params: TeamSearchParams): Promise<Row[]> {
    const max = clampLimit(params.limit, 40, 50);
    const select = `${IDENTITY_COLUMNS}, ${TEAM_EMBED}`;

    const rankedIds = await this.rankedIds(token, params.q, 'team', max);
    if (rankedIds && rankedIds.length === 0) return [];

    const client = this.supabase.asCaller(token);
    let req = client
      .from('identities')
      .select(select)
      .eq('kind', 'team')
      .eq('status', 'active');

    if (rankedIds) req = req.in('id', rankedIds);
    const blocked = await blockedIdentityIds(this.supabase, token);
    if (blocked.length) req = req.not('id', 'in', inList(blocked));
    if (params.verifiedOnly) req = req.eq('verified', true);
    if (params.categoryId) req = req.eq('teams.category_id', params.categoryId);
    if (params.gameId) req = req.eq('teams.primary_game_id', params.gameId);
    if (params.recruitingOnly) req = req.eq('teams.recruiting', 'open');

    const ordered = rankedIds
      ? req.limit(max)
      : req.order(orderColumn(params.order), { ascending: false }).limit(max);
    const rows = await this.supabase.run<Row[]>(ordered);
    return rankedIds ? this.inRankedOrder(rows, rankedIds) : rows;
  }

  async postsSearch(token: string, viewerId: string, q: string, limit?: number): Promise<unknown[]> {
    const rows = await this.supabase.rpcAsCaller<Array<{ id: string }>>(token, 'search_post_ids', {
      q,
      max_rows: clampLimit(limit, 20, 50),
    });
    const ids = (rows ?? []).map((r) => r.id);
    return this.posts.byIds(token, viewerId, ids);
  }

  /**
   * Ranked identity ids for a text query, or null when the query is empty
   * (browse mode — the caller orders by column instead of relevance).
   */
  private async rankedIds(
    token: string,
    q: string | undefined,
    targetKind: 'personal' | 'team',
    max: number,
  ): Promise<string[] | null> {
    const query = (q ?? '').trim();
    if (!query) return null;
    const ranked = await this.supabase.rpcAsCaller<Array<{ id: string }>>(token, 'search_identity_ids', {
      q: query,
      target_kind: targetKind,
      max_rows: max,
    });
    return (ranked ?? []).map((r) => r.id);
  }

  /** Restores the ranker's relevance order (PostgREST cannot sort by id list). */
  private inRankedOrder(rows: Row[], ids: string[]): Row[] {
    const order = new Map(ids.map((id, i) => [id, i]));
    return [...rows].sort((a, b) => (order.get(a.id) ?? ids.length) - (order.get(b.id) ?? ids.length));
  }
}

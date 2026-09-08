import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { AppException } from '../common/errors/app-exception';
import { blockedIdentityIds, inList } from '../common/db/blocks.util';
import { clampLimit } from '../common/dto/pagination.dto';
import {
  RecommendationService,
  type RankedSlateMeta,
} from '../recommendation/recommendation.service';
import { PlatformPolicyService } from '../platform/platform-policy.service';
import { ErrorCode } from '../common/errors/error-codes';
import type { CreatePostDto } from './dto/post.dto';

const SHORT_TYPE = 'short';

/**
 * A page of posts plus what a ranked read needs to describe itself.
 *
 * `cursor` is the opaque slate cursor when ranking served the page, and null on
 * the chronological path (which still pages by `before=created_at`). A client
 * that ignores `cursor` keeps working on the timestamp keyset, which is what
 * lets ranking ship without a coordinated app release.
 */
export interface PostPage {
  items: PostRow[];
  cursor: string | null;
  ranked: boolean;
  meta?: RankedSlateMeta;
}

/**
 * The shared post projection — identical to the app's `_columns` so every post
 * read returns the same shape (author identity, recruitment embed, media).
 */
const POST_COLUMNS = `
  id, author_id, type_id, caption, visibility, created_at, edited_at,
  reactions_count, comments_count, shares_count,
  identities!posts_author_id_fkey(kind, username, display_name, avatar_url, verified),
  recruitments!recruitments_post_id_fkey(id, game_id, role_id, game_role_slug, region,
    min_rank_tier, max_rank_tier, min_age, max_age, availability, requirements, status),
  media(id, provider, provider_uid, media_type, public_url, storage_path, thumbnail_url,
    mime_type, file_size_bytes, width, height, duration_seconds, position, deleted_at)
`;

interface MediaRow {
  deleted_at: string | null;
  position: number | null;
  [key: string]: unknown;
}
type PostRow = Record<string, unknown> & { id: string; media?: MediaRow[] };
interface Cursor {
  limit?: number;
  before?: string;
  /** Opaque ranked-slate cursor. Takes precedence over `before` when present. */
  cursor?: string;
}

/**
 * Posts: feed/detail/author reads (with reaction + saved hydration), create,
 * caption edit, media attach/order, delete, and saved posts. Everything is
 * keyed by the acting identity; RLS + `can_act_as` enforce ownership, and
 * deletion routes through `purge_post` (which enqueues media cleanup for the
 * existing pipeline — no provider secrets needed here).
 */
@Injectable()
export class PostsService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly recommendations: RecommendationService,
    private readonly platform: PlatformPolicyService,
  ) {}

  /**
   * The Home feed. Ranked when the `feed` surface is enabled, chronological
   * otherwise or whenever ranking cannot produce a slate.
   *
   * THE FALLBACK IS NOT AN ERROR PATH, it is the contract: an empty candidate
   * pool, a missing config, a database hiccup in the feature layer or a disabled
   * surface all end up here, and the user gets the feed Esporta shipped before
   * ranking existed rather than an error (§29).
   */
  async feed(token: string, viewerId: string, cursor: Cursor): Promise<PostPage> {
    const limit = clampLimit(cursor.limit, 10);
    const ranked = await this.rankedPage(token, viewerId, 'feed', limit, cursor.cursor);
    if (ranked) return ranked;
    const items = await this.chronological(token, viewerId, limit, cursor.before, false);
    return { items, cursor: null, ranked: false };
  }

  /** Shorts. Same ranked-then-chronological contract as {@link feed}. */
  async shorts(token: string, viewerId: string, cursor: Cursor): Promise<PostPage> {
    const limit = clampLimit(cursor.limit, 10);
    const ranked = await this.rankedPage(token, viewerId, 'shorts', limit, cursor.cursor);
    if (ranked) return ranked;
    const items = await this.chronological(token, viewerId, limit, cursor.before, true);
    return { items, cursor: null, ranked: false };
  }

  /**
   * Attempts a ranked page. Returns null when ranking did not produce one and
   * the caller must fall back.
   *
   * The two-layer eligibility contract lives here: the recommendation service
   * decides the ORDER (running with the service role, since the feature tables
   * hold every user's interest graph), and {@link byIds} then fetches those ids
   * with the CALLER's client so RLS decides what is actually returned. An id the
   * viewer may not see simply yields no row — so a ranking bug can mis-order a
   * feed but cannot leak a private, blocked or deleted post.
   */
  private async rankedPage(
    token: string,
    viewerId: string,
    surface: 'feed' | 'shorts',
    limit: number,
    cursor: string | undefined,
  ): Promise<PostPage | null> {
    const slate = await this.recommendations.rank({
      viewerId,
      surface,
      limit,
      cursor,
    });
    if (slate.fallback || slate.postIds.length === 0) return null;

    const items = await this.byIds(token, viewerId, slate.postIds);
    // Shorts with no surviving video are dropped here, as the chronological path
    // does — a clip whose media was deleted reaches the player as a blank page.
    const usable = surface === 'shorts' ? items.filter(hasPlayableVideo) : items;

    // Every ranked id was filtered out by RLS or media checks. Falling back
    // rather than returning an empty page keeps a viewer whose whole slate was
    // ineligible from seeing an empty feed.
    if (usable.length === 0) return null;

    return { items: usable, cursor: slate.nextCursor, ranked: true, meta: slate.meta };
  }

  /**
   * The original chronological read, unchanged in behaviour — still the fallback
   * and still what `before=` paginates.
   */
  private async chronological(
    token: string,
    viewerId: string,
    limit: number,
    before: string | undefined,
    shortsOnly: boolean,
  ): Promise<PostRow[]> {
    const client = this.supabase.asCaller(token);
    let query = client.from('posts').select(POST_COLUMNS);
    query = shortsOnly ? query.eq('type_id', SHORT_TYPE) : query.neq('type_id', SHORT_TYPE);
    const blocked = await blockedIdentityIds(this.supabase, token);
    if (blocked.length) query = query.not('author_id', 'in', inList(blocked));
    if (before) query = query.lt('created_at', before);
    const rows = await this.supabase.run<PostRow[]>(
      query.order('created_at', { ascending: false }).limit(limit),
    );
    return this.hydrate(token, viewerId, rows);
  }

  async byAuthor(token: string, viewerId: string, authorId: string, cursor: Cursor): Promise<PostRow[]> {
    const limit = clampLimit(cursor.limit, 20);
    const client = this.supabase.asCaller(token);
    let query = client
      .from('posts')
      .select(POST_COLUMNS)
      .eq('author_id', authorId)
      .neq('type_id', SHORT_TYPE);
    if (cursor.before) query = query.lt('created_at', cursor.before);
    const rows = await this.supabase.run<PostRow[]>(
      query.order('created_at', { ascending: false }).limit(limit),
    );
    return this.hydrate(token, viewerId, rows);
  }

  async byId(token: string, viewerId: string, postId: string): Promise<PostRow> {
    const client = this.supabase.asCaller(token);
    const row = await this.supabase.run<PostRow | null>(
      client.from('posts').select(POST_COLUMNS).eq('id', postId).maybeSingle(),
    );
    if (!row) throw AppException.notFound('Post not found.');
    const [hydrated] = await this.hydrate(token, viewerId, [row]);
    return hydrated;
  }

  /**
   * Fetches and hydrates posts for a set of ids, preserving the given id order
   * (PostgREST does not preserve `in` list order). Used by search and any
   * id-ranked list.
   */
  async byIds(token: string, viewerId: string, ids: string[]): Promise<PostRow[]> {
    if (ids.length === 0) return [];
    const client = this.supabase.asCaller(token);
    const rows = await this.supabase.run<PostRow[]>(
      client.from('posts').select(POST_COLUMNS).in('id', ids),
    );
    const hydrated = await this.hydrate(token, viewerId, rows);
    const order = new Map(ids.map((id, i) => [id, i]));
    return hydrated.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  }

  async create(token: string, authorId: string, dto: CreatePostDto): Promise<PostRow> {
    // Write-path policy gates (plan Parts 15/17): maintenance, suspension,
    // then the global+personal post_creation switch. Runs BEFORE any insert,
    // so a refused request writes nothing.
    await this.platform.assertNotSuspended(authorId);
    const isShort = dto.type_id === SHORT_TYPE;
    await this.platform.assertFeatureAllowed(
      authorId,
      'post_creation',
      ErrorCode.USER_POSTING_RESTRICTED,
      isShort
        ? 'Shorts are temporarily unavailable.'
        : 'Posting is temporarily unavailable.',
    );

    const client = this.supabase.asCaller(token);
    const created = await this.supabase.run<{ id: string }>(
      client
        .from('posts')
        .insert({
          author_id: authorId,
          type_id: dto.type_id,
          caption: dto.caption?.trim() || null,
          visibility: dto.visibility ?? 'public',
        })
        .select('id')
        .single(),
    );
    if (dto.media_ids?.length) {
      await this.attachMedia(token, created.id, dto.media_ids);
    }
    return this.byId(token, authorId, created.id);
  }

  async updateCaption(token: string, viewerId: string, postId: string, caption: string): Promise<PostRow> {
    const client = this.supabase.asCaller(token);
    await this.supabase.run(
      client.from('posts').update({ caption: caption.trim() }).eq('id', postId),
    );
    return this.byId(token, viewerId, postId);
  }

  /** Deletes a post; `purge_post` authorises, deletes and queues media cleanup. */
  async delete(token: string, postId: string): Promise<{ deleted: true }> {
    await this.supabase.rpcAsCaller(token, 'purge_post', { p_post_id: postId });
    return { deleted: true };
  }

  async attachMedia(token: string, postId: string, mediaIds: string[]): Promise<{ attached: number }> {
    await this.supabase.rpcAsCaller(token, 'attach_media_to_post', {
      p_post_id: postId,
      p_media_ids: mediaIds,
    });
    return { attached: mediaIds.length };
  }

  async orderMedia(token: string, mediaIds: string[]): Promise<{ ordered: number }> {
    const client = this.supabase.asCaller(token);
    for (let i = 0; i < mediaIds.length; i++) {
      await this.supabase.run(client.from('media').update({ position: i }).eq('id', mediaIds[i]));
    }
    return { ordered: mediaIds.length };
  }

  // --------------------------------------------------------------- saved posts
  async saved(token: string, viewerId: string, cursor: Cursor): Promise<PostRow[]> {
    const limit = clampLimit(cursor.limit, 30);
    const client = this.supabase.asCaller(token);
    let savedQuery = client
      .from('saved_posts')
      .select('post_id, created_at')
      .eq('identity_id', viewerId);
    if (cursor.before) savedQuery = savedQuery.lt('created_at', cursor.before);
    const savedRows = await this.supabase.run<Array<{ post_id: string; created_at: string }>>(
      savedQuery.order('created_at', { ascending: false }).limit(limit),
    );
    if (savedRows.length === 0) return [];
    const ids = savedRows.map((r) => r.post_id);
    const rows = await this.supabase.run<PostRow[]>(
      client.from('posts').select(POST_COLUMNS).in('id', ids),
    );
    const hydrated = await this.hydrate(token, viewerId, rows);
    // Preserve save order (PostgREST does not preserve the `in` list order).
    const order = new Map(ids.map((id, i) => [id, i]));
    return hydrated.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  }

  async save(token: string, viewerId: string, postId: string): Promise<{ saved: true }> {
    const client = this.supabase.asCaller(token);
    await this.supabase.run(
      client
        .from('saved_posts')
        .upsert({ identity_id: viewerId, post_id: postId }, { onConflict: 'identity_id,post_id' }),
    );
    return { saved: true };
  }

  async unsave(token: string, viewerId: string, postId: string): Promise<{ saved: false }> {
    const client = this.supabase.asCaller(token);
    await this.supabase.run(
      client.from('saved_posts').delete().eq('identity_id', viewerId).eq('post_id', postId),
    );
    return { saved: false };
  }

  /**
   * Attaches per-viewer engagement to post rows: reaction breakdown, the
   * viewer's own reaction, saved flag, and cleaned/sorted media. Batched to
   * avoid per-post round trips.
   */
  private async hydrate(token: string, viewerId: string, rows: PostRow[]): Promise<PostRow[]> {
    if (rows.length === 0) return rows;
    const ids = rows.map((r) => r.id);
    const client = this.supabase.asCaller(token);

    const [breakdown, mineRows, savedRows] = await Promise.all([
      this.supabase.rpcAsCaller<Record<string, Record<string, number>> | null>(
        token,
        'post_reactions_breakdown',
        { p_post_ids: ids },
      ),
      this.supabase.run<Array<{ post_id: string; type_id: string }>>(
        client.from('reactions').select('post_id, type_id').eq('identity_id', viewerId).in('post_id', ids),
      ),
      this.supabase.run<Array<{ post_id: string }>>(
        client.from('saved_posts').select('post_id').eq('identity_id', viewerId).in('post_id', ids),
      ),
    ]);

    const mine = new Map(mineRows.map((r) => [r.post_id, r.type_id]));
    const saved = new Set(savedRows.map((r) => r.post_id));

    return rows.map((r) => {
      const media = Array.isArray(r.media)
        ? [...r.media]
            .filter((m) => m.deleted_at == null)
            .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
        : [];
      return {
        ...r,
        media,
        reactions: breakdown?.[r.id] ?? {},
        my_reaction: mine.get(r.id) ?? null,
        liked: mine.has(r.id),
        saved: saved.has(r.id),
      };
    });
  }
}

/**
 * Whether a post still has playable video.
 *
 * The chronological Shorts path has always dropped clips whose media was deleted
 * (the app would otherwise render a blank page to swipe past). The ranked path
 * applies the same rule so the two cannot disagree about what a valid short is.
 */
function hasPlayableVideo(row: PostRow): boolean {
  return (
    Array.isArray(row.media) &&
    row.media.some((m) => m.deleted_at == null && m.media_type === 'video')
  );
}

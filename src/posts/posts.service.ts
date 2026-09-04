import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { AppException } from '../common/errors/app-exception';
import { blockedIdentityIds, inList } from '../common/db/blocks.util';
import { clampLimit } from '../common/dto/pagination.dto';
import type { CreatePostDto } from './dto/post.dto';

const SHORT_TYPE = 'short';

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
  constructor(private readonly supabase: SupabaseService) {}

  async feed(token: string, viewerId: string, cursor: Cursor): Promise<PostRow[]> {
    const limit = clampLimit(cursor.limit, 10);
    const client = this.supabase.asCaller(token);
    let query = client.from('posts').select(POST_COLUMNS).neq('type_id', SHORT_TYPE);
    const blocked = await blockedIdentityIds(this.supabase, token);
    if (blocked.length) query = query.not('author_id', 'in', inList(blocked));
    if (cursor.before) query = query.lt('created_at', cursor.before);
    const rows = await this.supabase.run<PostRow[]>(
      query.order('created_at', { ascending: false }).limit(limit),
    );
    return this.hydrate(token, viewerId, rows);
  }

  async shorts(token: string, viewerId: string, cursor: Cursor): Promise<PostRow[]> {
    const limit = clampLimit(cursor.limit, 10);
    const client = this.supabase.asCaller(token);
    let query = client.from('posts').select(POST_COLUMNS).eq('type_id', SHORT_TYPE);
    const blocked = await blockedIdentityIds(this.supabase, token);
    if (blocked.length) query = query.not('author_id', 'in', inList(blocked));
    if (cursor.before) query = query.lt('created_at', cursor.before);
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

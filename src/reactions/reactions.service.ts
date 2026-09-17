import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { clampLimit } from '../common/dto/pagination.dto';

const DEFAULT_TYPE = 'love';

const REACTOR_COLUMNS =
  'type_id, created_at, identities!reactions_identity_id_fkey(id, kind, username, display_name, avatar_url, verified)';

/**
 * Post/comment reactions. One reaction per identity per target (enforced by a
 * unique index); setting a reaction inserts or switches the type, removing it
 * deletes the row. Count columns are trigger-maintained and only read back.
 */
@Injectable()
export class ReactionsService {
  constructor(private readonly supabase: SupabaseService) {}

  reactPost(token: string, identityId: string, postId: string, typeId?: string) {
    return this.set(token, 'post_id', postId, identityId, typeId ?? DEFAULT_TYPE, 'posts');
  }

  unreactPost(token: string, identityId: string, postId: string) {
    return this.clear(token, 'post_id', postId, identityId, 'posts');
  }

  reactComment(token: string, identityId: string, commentId: string, typeId?: string) {
    return this.set(token, 'comment_id', commentId, identityId, typeId ?? DEFAULT_TYPE, 'comments');
  }

  unreactComment(token: string, identityId: string, commentId: string) {
    return this.clear(token, 'comment_id', commentId, identityId, 'comments');
  }

  listPostReactions(token: string, postId: string, type: string | undefined, limit?: number, offset = 0) {
    return this.reactors(token, 'post_id', postId, type, limit, offset);
  }

  listCommentReactions(token: string, commentId: string, type: string | undefined, limit?: number, offset = 0) {
    return this.reactors(token, 'comment_id', commentId, type, limit, offset);
  }

  private async set(
    token: string,
    key: 'post_id' | 'comment_id',
    targetId: string,
    identityId: string,
    typeId: string,
    targetTable: 'posts' | 'comments',
  ) {
    const client = this.supabase.asCaller(token);
    const existing = await this.supabase.run<{ id: string; type_id: string } | null>(
      client.from('reactions').select('id, type_id').eq('identity_id', identityId).eq(key, targetId).maybeSingle(),
    );
    if (!existing) {
      await this.supabase.run(
        client.from('reactions').insert({ identity_id: identityId, [key]: targetId, type_id: typeId }),
      );
    } else if (existing.type_id !== typeId) {
      await this.supabase.run(client.from('reactions').update({ type_id: typeId }).eq('id', existing.id));
    }
    return { type_id: typeId, count: await this.count(client, targetTable, targetId) };
  }

  private async clear(
    token: string,
    key: 'post_id' | 'comment_id',
    targetId: string,
    identityId: string,
    targetTable: 'posts' | 'comments',
  ) {
    const client = this.supabase.asCaller(token);
    await this.supabase.run(
      client.from('reactions').delete().eq('identity_id', identityId).eq(key, targetId),
    );
    return { type_id: null, count: await this.count(client, targetTable, targetId) };
  }

  private async reactors(
    token: string,
    key: 'post_id' | 'comment_id',
    targetId: string,
    type: string | undefined,
    limit: number | undefined,
    offset: number,
  ) {
    const take = clampLimit(limit, 30, 100);
    const client = this.supabase.asCaller(token);
    let query = client.from('reactions').select(REACTOR_COLUMNS).eq(key, targetId);
    if (type) query = query.eq('type_id', type);
    return this.supabase.run(
      query.order('created_at', { ascending: false }).range(offset, offset + take - 1),
    );
  }

  private async count(
    client: ReturnType<SupabaseService['asCaller']>,
    table: 'posts' | 'comments',
    id: string,
  ): Promise<number> {
    const row = await this.supabase.run<{ reactions_count: number } | null>(
      client.from(table).select('reactions_count').eq('id', id).maybeSingle(),
    );
    return row?.reactions_count ?? 0;
  }
}

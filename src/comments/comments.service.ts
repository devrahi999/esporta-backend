import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { AppException } from '../common/errors/app-exception';
import { ErrorCode } from '../common/errors/error-codes';
import { clampLimit } from '../common/dto/pagination.dto';
import { PlatformPolicyService } from '../platform/platform-policy.service';

const COMMENT_COLUMNS = `
  id, post_id, author_id, parent_id, body, created_at, edited_at,
  reactions_count, replies_count,
  identities!comments_author_id_fkey(kind, username, display_name, avatar_url, verified)
`;

type CommentRow = Record<string, unknown> & { id: string };

/**
 * Comments on posts, with the author identity joined and the viewer's own
 * reaction + reaction breakdown hydrated (mirrors the app's comment thread).
 */
@Injectable()
export class CommentsService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly platform: PlatformPolicyService,
  ) {}

  async forPost(token: string, viewerId: string, postId: string, limit?: number): Promise<CommentRow[]> {
    const take = clampLimit(limit, 100, 200);
    const client = this.supabase.asCaller(token);
    const rows = await this.supabase.run<CommentRow[]>(
      client
        .from('comments')
        .select(COMMENT_COLUMNS)
        .eq('post_id', postId)
        .order('created_at', { ascending: true })
        .limit(take),
    );
    return this.hydrate(token, viewerId, rows);
  }

  async add(
    token: string,
    authorId: string,
    postId: string,
    body: string,
    parentId?: string,
  ): Promise<CommentRow> {
    // Policy gates (plan Parts 15/17): comments switch + suspension, before
    // any insert. Reports/notifications stay untouched — only the write path
    // that creates user-visible content is gated.
    await this.platform.assertNotSuspended(authorId);
    await this.platform.assertFeatureAllowed(
      authorId,
      'comments',
      ErrorCode.COMMENTS_DISABLED,
      'Comments are temporarily unavailable.',
    );

    const client = this.supabase.asCaller(token);
    return this.supabase.run<CommentRow>(
      client
        .from('comments')
        .insert({
          post_id: postId,
          author_id: authorId,
          body: body.trim(),
          parent_id: parentId ?? null,
        })
        .select(COMMENT_COLUMNS)
        .single(),
    );
  }

  async edit(token: string, commentId: string, body: string): Promise<CommentRow> {
    const client = this.supabase.asCaller(token);
    await this.supabase.run(
      client
        .from('comments')
        .update({ body: body.trim(), edited_at: new Date().toISOString() })
        .eq('id', commentId),
    );
    const row = await this.supabase.run<CommentRow | null>(
      client.from('comments').select(COMMENT_COLUMNS).eq('id', commentId).maybeSingle(),
    );
    if (!row) throw AppException.notFound('Comment not found.');
    return row;
  }

  async delete(token: string, commentId: string): Promise<{ deleted: true }> {
    const client = this.supabase.asCaller(token);
    await this.supabase.run(client.from('comments').delete().eq('id', commentId));
    return { deleted: true };
  }

  private async hydrate(token: string, viewerId: string, rows: CommentRow[]): Promise<CommentRow[]> {
    if (rows.length === 0) return rows;
    const ids = rows.map((r) => r.id);
    const client = this.supabase.asCaller(token);
    const [breakdown, mineRows] = await Promise.all([
      this.supabase.rpcAsCaller<Record<string, Record<string, number>> | null>(
        token,
        'comment_reactions_breakdown',
        { p_comment_ids: ids },
      ),
      this.supabase.run<Array<{ comment_id: string; type_id: string }>>(
        client.from('reactions').select('comment_id, type_id').eq('identity_id', viewerId).in('comment_id', ids),
      ),
    ]);
    const mine = new Map(mineRows.map((r) => [r.comment_id, r.type_id]));
    return rows.map((r) => ({
      ...r,
      reactions: breakdown?.[r.id] ?? {},
      my_reaction: mine.get(r.id) ?? null,
    }));
  }
}

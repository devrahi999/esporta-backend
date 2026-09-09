import { Injectable } from '@nestjs/common';
import { SupabaseService, mapPostgrestError } from '../supabase/supabase.service';
import { clampLimit } from '../common/dto/pagination.dto';

const NOTIFICATION_SELECT = `
  id, type_id, title, body, read_at, created_at, entity_type, entity_id, actor_id, recipient_id,
  actor_hidden:notification_actor_hidden,
  notification_types!inner(label, group_label, actionable, in_app),
  identities!notifications_actor_id_fkey(display_name, avatar_url, verified, kind)
`;

type Row = Record<string, unknown>;

/**
 * In-app notifications for the active inbox (the resolved active identity — a
 * team's notifications are separate from its owner's). Notifications are
 * trigger-written elsewhere; this only reads, marks read (via
 * `mark_notifications_read`), counts unread, and dismisses.
 *
 * **Channel policy:** `notification_types.in_app` is the single switch for the
 * in-app centre. Push-only kinds (a followed author's new post/short) and
 * email-only kinds (security alerts) keep their rows — the push pipeline reads
 * them — but both `list` and `unreadCount` filter them out here, so a push-only
 * event reaches the phone and never the bell, and the badge cannot disagree
 * with the list.
 */
@Injectable()
export class NotificationsService {
  constructor(private readonly supabase: SupabaseService) {}

  list(token: string, inboxId: string, limit?: number): Promise<Row[]> {
    const take = clampLimit(limit, 60, 100);
    const client = this.supabase.asCaller(token);
    return this.supabase.run<Row[]>(
      client
        .from('notifications')
        .select(NOTIFICATION_SELECT)
        .eq('recipient_id', inboxId)
        .eq('notification_types.in_app', true)
        .order('created_at', { ascending: false })
        .limit(take),
    );
  }

  async unreadCount(token: string, inboxId: string): Promise<{ count: number }> {
    const { count, error } = await this.supabase
      .asCaller(token)
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('recipient_id', inboxId)
      .is('read_at', null)
      .eq('notification_types.in_app', true);
    if (error) throw mapPostgrestError(error);
    return { count: count ?? 0 };
  }

  async markRead(token: string, ids: string[]): Promise<{ updated: number }> {
    if (ids.length === 0) return { updated: 0 };
    const updated = await this.supabase.rpcAsCaller<number>(token, 'mark_notifications_read', { p_ids: ids });
    return { updated: updated ?? 0 };
  }

  async markAll(token: string, inboxId: string): Promise<{ updated: number }> {
    const client = this.supabase.asCaller(token);
    const rows = await this.supabase.run<Array<{ id: string }>>(
      client.from('notifications').select('id').eq('recipient_id', inboxId).is('read_at', null),
    );
    return this.markRead(token, rows.map((r) => r.id));
  }

  async dismiss(token: string, id: string): Promise<{ deleted: true }> {
    const client = this.supabase.asCaller(token);
    await this.supabase.run(client.from('notifications').delete().eq('id', id));
    return { deleted: true };
  }
}

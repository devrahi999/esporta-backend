import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { AppException } from '../common/errors/app-exception';
import { FcmProvider } from './providers/fcm.provider';

interface Target {
  device_id: string;
  token: string;
  platform: string;
  user_id: string;
}
interface Delivery {
  delivery_id: string;
  notification_id: string;
  type_id: string;
  entity_type: string | null;
  entity_id: string | null;
  recipient_id: string;
  actor_id: string | null;
  /**
   * The acting identity's avatar, resolved by `claim_push_deliveries`.
   *
   * Null for anything Esporta itself sent — admin broadcasts store
   * `actor_id = NULL` — and also null for a support reply, which does carry an
   * actor but is Esporta speaking, so the claim function suppresses it rather
   * than putting a staff member's face in a user's tray. Null falls back to
   * [BRAND_IMAGE_URL], the Esporta mark, in the notification's large-icon slot.
   */
  actor_avatar_url: string | null;
  /** `personal` or `team` — which kind of profile acted. */
  actor_kind: string | null;
  hide_actor: boolean | null;
  channel: string;
  payload: { title?: string; body?: string };
  targets: Target[];
}

export interface DispatchSummary {
  ok: true;
  deliveries: number;
  sent: number;
  failed: number;
  pruned: number;
  rounds: number;
}

const str = (v: unknown): string => (v == null ? '' : String(v));

/**
 * The Esporta mark, shown as the notification's right-side (large) icon for
 * every message Esporta itself sends — the same slot an actor's avatar takes
 * for social notifications. Without it, stock Android renders no large icon at
 * all for actor-less pushes, so system notifications carried no branding while
 * social ones did. FCM's `notification.image` is the only right-side mechanism
 * in the v1 API; a square 512px mark keeps it at normal icon size.
 */
const BRAND_IMAGE_URL =
  process.env.NOTIFICATION_BRAND_IMAGE_URL ??
  'https://app.esporta.site/esporta-mark.jpg';

/**
 * Drains the `notification_deliveries` queue and sends via FCM.
 *
 * **The only push dispatcher in the product.** Postgres nudges
 * `POST /api/v1/webhooks/internal/push-dispatch` through `push_dispatch_wake`
 * (pg_net, debounced) and a `pg_cron` drain covers anything a nudge missed.
 * Everything about *who* to send to was already decided in Postgres by
 * `claim_push_deliveries` (recipient's active profile + per-channel preference);
 * this stays dumb about policy. Short-lived and batch-bounded to fit Vercel's
 * request model (plan §41); the DB cron safety net picks up anything left.
 */
@Injectable()
export class PushDispatchService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly fcm: FcmProvider,
  ) {}

  async dispatch(): Promise<DispatchSummary> {
    if (!this.fcm.configured) throw AppException.unavailable('Push (FCM) is not configured.');
    if (!this.fcm.projectId) throw AppException.unavailable('FIREBASE_PROJECT_ID is not set.');

    const accessToken = await this.fcm.prepare();
    let deliveries = 0;
    let sentTotal = 0;
    let failedTotal = 0;
    let rounds = 0;
    const deadTokens = new Set<string>();
    const startedAt = Date.now();

    while (true) {
      const batch = await this.supabase.rpcAsService<Delivery[]>('claim_push_deliveries', { p_limit: 50 });
      const list = Array.isArray(batch) ? batch : [];
      if (list.length === 0) break;
      rounds++;

      for (const d of list) {
        deliveries++;
        const title = d.payload?.title ?? 'Esporta';
        const body = d.payload?.body ?? '';
        const data: Record<string, string> = {
          type: str(d.type_id),
          entity_type: str(d.entity_type),
          entity_id: str(d.entity_id),
          recipient_id: str(d.recipient_id),
          actor_id: str(d.actor_id),
          notification_id: str(d.notification_id),
          // Additive: the app ignores keys it does not know, and every existing
          // routing key above is untouched. These two say *which profile* acted —
          // the personal one, or the team/other profile the user was acting as —
          // so a client can draw the right avatar without a lookup per row.
          actor_avatar_url: str(d.actor_avatar_url),
          actor_type: str(d.actor_kind),
        };

        // Actor-less (Esporta speaking) gets the brand mark in the large-icon
        // slot; an actor's avatar when there is one. Either way the tray shows
        // an identity on the right side.
        const imageUrl = d.actor_avatar_url ?? BRAND_IMAGE_URL;

        let sent = 0;
        let failed = 0;
        const errors: Array<Record<string, unknown>> = [];
        for (const t of d.targets ?? []) {
          try {
            const r = await this.fcm.sendOne(accessToken, t.token, title, body, data, imageUrl);
            if (r.ok) sent++;
            else {
              failed++;
              if (r.unregistered) deadTokens.add(t.token);
              errors.push({ device_id: t.device_id, unregistered: r.unregistered, error: r.error });
            }
          } catch (e) {
            failed++;
            errors.push({ device_id: t.device_id, error: e instanceof Error ? e.message : String(e) });
          }
        }

        sentTotal += sent;
        failedTotal += failed;
        const status = sent > 0 ? 'sent' : failed > 0 ? 'failed' : 'skipped';
        await this.supabase.rpcAsService('complete_push_delivery', {
          p_delivery_id: d.delivery_id,
          p_status: status,
          p_result: { sent, failed, targets: (d.targets ?? []).length, errors: errors.slice(0, 10) },
          p_error: failed > 0 ? str(errors[0]?.error ?? 'send failed').slice(0, 500) : null,
        });
      }

      if (rounds >= 20 || Date.now() - startedAt > 50_000) break;
    }

    if (deadTokens.size > 0) {
      await this.supabase.rpcAsService('deactivate_push_tokens', { p_tokens: Array.from(deadTokens) });
    }

    return { ok: true, deliveries, sent: sentTotal, failed: failedTotal, pruned: deadTokens.size, rounds };
  }
}

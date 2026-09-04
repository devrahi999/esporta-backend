import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { EmailService, type SendResult } from './email.service';

interface OutboxRow {
  id: string;
  user_id: string | null;
  to_email: string;
  template: string;
  vars: Record<string, unknown> | null;
}

/** Per-failure detail. Safe to log; the API surfaces only the counts + a code. */
export interface OutboxFailure {
  template: string;
  error?: string;
  providerCode?: number;
  failureKind?: string;
}

export interface OutboxFlushResult {
  attempted: number;
  sent: number;
  failed: number;
  /** True when nothing was queued OR everything queued was accepted by SMTP. */
  ok: boolean;
  /** Set when the transport is unconfigured, so callers can say so precisely. */
  skipped?: string;
  failures: OutboxFailure[];
}

/**
 * Drains `public.email_outbox` through {@link EmailService}.
 *
 * The DB security RPCs still own OTP minting, hashing, expiry, cooldown, rate
 * limits and verification — unchanged. All they do differently now is enqueue an
 * outbox row instead of firing pg_net at an Edge Function. This service collects
 * those rows inside the SAME HTTP request that triggered them, so the endpoint
 * can tell the client whether the mail was really accepted.
 *
 * Claiming requires the service-role key: a claimed row carries the plaintext
 * code, and `email_outbox_claim` is revoked from anon/authenticated. Both
 * `email_outbox_claim` (staleness sweep) and `email_outbox_complete` scrub
 * `vars`, so a code never outlives its dispatch attempt.
 */
@Injectable()
export class EmailOutboxService {
  private readonly log = new Logger(EmailOutboxService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly email: EmailService,
  ) {}

  /**
   * Sends everything queued for [userId]. Never throws: the caller's security
   * operation has already succeeded server-side, and a delivery fault must be
   * reported rather than mistaken for a failed operation.
   */
  async flushForUser(userId: string, limit = 5): Promise<OutboxFlushResult> {
    const empty: OutboxFlushResult = { attempted: 0, sent: 0, failed: 0, ok: true, failures: [] };
    if (!userId) return empty;

    let rows: OutboxRow[] = [];
    try {
      const data = await this.supabase.rpcAsService<OutboxRow[] | null>('email_outbox_claim', {
        p_user: userId,
        p_limit: limit,
      });
      rows = Array.isArray(data) ? data : [];
    } catch (e) {
      this.log.error(`email_outbox_claim failed: ${e instanceof Error ? e.message : String(e)}`);
      return { ...empty, ok: false, failures: [{ template: 'outbox', error: 'claim_failed' }] };
    }

    if (rows.length === 0) return empty;

    const result: OutboxFlushResult = {
      attempted: rows.length,
      sent: 0,
      failed: 0,
      ok: true,
      failures: [],
    };

    for (const row of rows) {
      let outcome: SendResult;
      try {
        outcome = await this.email.sendTemplate(row.to_email, row.template, row.vars ?? {});
      } catch (e) {
        outcome = { sent: false, error: e instanceof Error ? e.message : String(e) };
      }

      if (outcome.sent) {
        result.sent += 1;
      } else {
        result.failed += 1;
        result.ok = false;
        if (outcome.skipped) result.skipped = outcome.skipped;
        result.failures.push({
          template: row.template,
          error: outcome.error,
          providerCode: outcome.providerCode,
          failureKind: outcome.failureKind,
        });
      }

      await this.complete(row.id, outcome);
    }

    if (!result.ok) {
      this.log.warn(
        `outbox flush incomplete attempted=${result.attempted} sent=${result.sent} ` +
          `failed=${result.failed} kinds=${result.failures.map((f) => f.failureKind ?? 'unknown').join(',')}`,
      );
    }
    return result;
  }

  private async complete(id: string, outcome: SendResult): Promise<void> {
    const reason = outcome.sent
      ? null
      : [outcome.skipped, outcome.failureKind, outcome.providerCode, outcome.error]
          .filter((v) => v !== undefined && v !== null && v !== '')
          .join(' | ')
          .slice(0, 400);
    try {
      await this.supabase.rpcAsService('email_outbox_complete', {
        p_id: id,
        p_ok: outcome.sent,
        p_error: reason,
      });
    } catch (e) {
      // The message may well have gone out; losing the bookkeeping must not
      // turn a delivered email into a reported failure.
      this.log.error(`email_outbox_complete failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Collapses a flush into the `delivery` block the security endpoints return.
   * Deliberately coarse: the client learns whether to trust "code sent", not the
   * provider's wording.
   */
  static toDelivery(flush: OutboxFlushResult): {
    attempted: number;
    sent: number;
    failed: number;
    emailDispatched: boolean;
    reason?: string;
  } {
    return {
      attempted: flush.attempted,
      sent: flush.sent,
      failed: flush.failed,
      // Nothing queued means nothing was owed (e.g. alerts disabled), which is fine.
      emailDispatched: flush.attempted === 0 ? true : flush.sent > 0,
      reason: flush.ok
        ? undefined
        : flush.skipped ?? flush.failures[0]?.failureKind ?? 'delivery_failed',
    };
  }
}

import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { AppException } from '../common/errors/app-exception';
import { ErrorCode } from '../common/errors/error-codes';
import type { AnalyticsEventDto } from './dto/analytics.dto';
import { validateAnalyticsEvent } from './validators/event.validator';

/**
 * Product analytics ingestion (Analytics Part 1). Events are written through
 * `analytics_ingest_events` on the caller's own client, so the ledger's
 * `actor_user_id` is `auth.uid()` and nothing in the payload can change it;
 * the acting identity arrives via the `X-Active-Profile-Id` header the
 * {@link ActiveProfileGuard} has already validated with `can_act_as`, and the
 * function checks it a second time — a team identity can never be spoofed
 * (plan §6).
 *
 * The contract is strict by design (plan §7, §12): a frozen taxonomy, flat
 * size-capped properties, a per-user rate limit, and duplicate immunity via
 * the client-generated `event_id`. Nothing invalid is silently accepted, and
 * nothing accepted can be rewritten — `analytics_events` is an append-only
 * ledger that Parts 2–3 aggregate on top of.
 */
@Injectable()
export class AnalyticsService {
  // ---------------------------------------------------------- rate limiting
  // Plan §7: the endpoint must not be public-uncontrolled. Per-user sliding
  // windows held in process memory. On Vercel each instance counts only its
  // own traffic, so the real ceiling is (limit × instance count) — this is a
  // deliberate abuse brake, not a billing meter. A shared store (Redis) can
  // tighten it later without touching callers.
  private static readonly MAX_REQUESTS_PER_MIN = 60;
  private static readonly MAX_EVENTS_PER_MIN = 600;
  private static readonly WINDOW_MS = 60_000;

  /** userId → timestamps of recent ingest requests / events. */
  private readonly requestHits = new Map<string, number[]>();
  private readonly eventHits = new Map<string, number[]>();

  constructor(private readonly supabase: SupabaseService) {}

  async ingest(
    token: string,
    userId: string,
    identityId: string | undefined,
    events: AnalyticsEventDto[],
  ): Promise<{ received: number; ingested: number; duplicates: number }> {
    this.assertRateLimit(userId, events.length);

    // Validate every event before touching the database. One bad event
    // refuses the whole batch: the client can re-send after fixing, and the
    // ledger never ends up with a partially-valid slice of a request.
    for (let i = 0; i < events.length; i++) {
      const issue = validateAnalyticsEvent(events[i], i);
      if (issue) {
        throw AppException.badRequest(
          `event ${issue.index}: ${issue.message}`,
          ErrorCode.INVALID_ANALYTICS_EVENT,
          { index: issue.index },
        );
      }
    }

    // Only the taxonomy's own fields reach the database — `actor_user_id` is
    // deliberately absent, because the function reads it from the caller's JWT
    // rather than trusting anything we send.
    const payload = events.map((e) => ({
      name: e.name,
      entity_type: e.entity_type ?? null,
      entity_id: e.entity_id ?? null,
      event_id: e.event_id ?? null,
      properties: e.properties ?? {},
      session_id: e.session_id ?? null,
      platform: e.platform ?? null,
      app_version: e.app_version ?? null,
    }));

    // Duplicate protection (plan §3) is one database statement:
    // `on conflict (client_event_id) do nothing` over the whole batch, so a
    // retried delivery resolves to a no-op, a duplicate repeated inside one
    // batch is skipped too, and a concurrent submission of the same id waits
    // for the first to commit and then skips. `ingested` counts rows that
    // actually landed, so `duplicates` is measured rather than guessed.
    //
    // This has to be an RPC, not a table upsert. `analytics_events` is
    // insert-only for clients by design (no SELECT), and PostgreSQL requires
    // SELECT on the arbiter column merely to NAME a conflict target — plus
    // SELECT again for the `returning` that counts what landed. A PostgREST
    // upsert therefore cannot dedupe here without opening the raw ledger to
    // clients. The SECURITY DEFINER function does both inside the database
    // while the call still travels on the caller's token, so `auth.uid()` is
    // the actor and the acting identity is re-checked with `can_act_as`.
    return this.supabase.rpcAsCaller<{
      received: number;
      ingested: number;
      duplicates: number;
    }>(token, 'analytics_ingest_events', {
      p_events: payload,
      p_identity_id: identityId ?? null,
    });
  }

  /** Sliding-window check; throws 429 RATE_LIMITED when either cap is exceeded. */
  private assertRateLimit(userId: string, incomingEvents: number): void {
    const now = Date.now();
    const requests = this.prune(this.requestHits, userId, now);
    const totalEvents = this.prune(this.eventHits, userId, now);

    if (requests.length >= AnalyticsService.MAX_REQUESTS_PER_MIN) {
      throw new AppException(
        429,
        ErrorCode.RATE_LIMITED,
        'Too many analytics requests. Slow down.',
      );
    }
    if (totalEvents.length + incomingEvents > AnalyticsService.MAX_EVENTS_PER_MIN) {
      throw new AppException(
        429,
        ErrorCode.RATE_LIMITED,
        'Too many analytics events per minute.',
      );
    }

    requests.push(now);
    for (let i = 0; i < incomingEvents; i++) totalEvents.push(now);
  }

  /** Drops timestamps outside the window; creates the entry when missing. */
  private prune(map: Map<string, number[]>, userId: string, now: number): number[] {
    let hits = map.get(userId);
    if (!hits) {
      hits = [];
      map.set(userId, hits);
    }
    const cutoff = now - AnalyticsService.WINDOW_MS;
    while (hits.length > 0 && hits[0] <= cutoff) hits.shift();
    return hits;
  }
}

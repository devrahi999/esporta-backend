import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { AppException } from '../common/errors/app-exception';

/**
 * Runs the Postgres aggregation functions (Part 2) with the service role.
 *
 * The aggregation lives in `analytics_aggregate_*` (SECURITY DEFINER,
 * machine-only) so the idempotent recompute-and-replace semantics, the day
 * boundaries and the metric mappings are in ONE place next to the data. This
 * service is only the trigger: the scheduled cron hits
 * `/webhooks/internal/analytics-aggregate`, and an operator can call the same
 * endpoint to backfill after a fix.
 */
@Injectable()
export class AnalyticsAggregateService {
  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Recomputes the trailing [p_days] UTC days (default 7) — today plus a
   * late-arrival window. Re-running is always safe: each day bucket is
   * rebuilt from the raw ledger and replaces the previous rows.
   */
  async runRecent(days = 7): Promise<unknown> {
    if (!Number.isInteger(days) || days < 1 || days > 92) {
      throw AppException.badRequest('days must be an integer between 1 and 92.');
    }
    return this.supabase.rpcAsService('analytics_aggregate_recent', { p_days: days });
  }

  /** Recomputes an explicit inclusive UTC date range (backfills, ≤ 92 days). */
  async runRange(from: string, to: string): Promise<unknown> {
    return this.supabase.rpcAsService('analytics_aggregate_range', { p_from: from, p_to: to });
  }
}

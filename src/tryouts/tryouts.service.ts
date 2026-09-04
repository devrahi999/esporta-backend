import { Injectable } from '@nestjs/common';
import { SupabaseService, mapPostgrestError } from '../supabase/supabase.service';
import { AppException } from '../common/errors/app-exception';
import { describeEligibilityFailure } from '../common/errors/eligibility';
import { ErrorCode } from '../common/errors/error-codes';
import type { CreateTryoutDto } from './dto/tryout.dto';

const TRYOUT_SELECT =
  'id, application_id, team_id, player_id, tryout_date, tryout_time, matches_count, sessions_count, note, status, completed_at, created_at, notified_at';

type Row = Record<string, unknown>;

/**
 * Tryouts scheduled against an application. `team_id`/`player_id` are filled by
 * the `fill_tryout_parties` trigger from the application; `completed_at` by the
 * transition guard. `notify_tryout` re-notifies the player under a cooldown.
 */
@Injectable()
export class TryoutsService {
  constructor(private readonly supabase: SupabaseService) {}

  listForApplication(token: string, applicationId: string): Promise<Row[]> {
    const client = this.supabase.asCaller(token);
    return this.supabase.run<Row[]>(
      client.from('tryouts').select(TRYOUT_SELECT).eq('application_id', applicationId).order('created_at'),
    );
  }

  /**
   * Schedules a trial.
   *
   * `team_id` / `player_id` are filled by `fill_tryout_parties` from the
   * application, and `guard_tryout_capability` then refuses two things: a tryout
   * on a sponsorship (there is nothing to watch), and a tryout for anybody but a
   * player (a coach or an analyst is not scrimmed). Both refusals are renamed here
   * so the app shows a sentence instead of a constraint name.
   */
  async create(token: string, applicationId: string, dto: CreateTryoutDto): Promise<Row> {
    const client = this.supabase.asCaller(token);
    try {
      return await this.supabase.run<Row>(
        client
          .from('tryouts')
          .insert({
            application_id: applicationId,
            tryout_date: dto.tryout_date,
            tryout_time: dto.tryout_time,
            matches_count: dto.matches_count,
            sessions_count: dto.sessions_count ?? null,
            note: dto.note ?? null,
          })
          .select(TRYOUT_SELECT)
          .single(),
      );
    } catch (error) {
      throw describeEligibilityFailure(error);
    }
  }

  setStatus(token: string, id: string, status: string): Promise<Row> {
    const client = this.supabase.asCaller(token);
    return this.supabase.run<Row>(
      client.from('tryouts').update({ status }).eq('id', id).select(TRYOUT_SELECT).single(),
    );
  }

  /** Re-notifies the player; maps the server cooldown to 429 with seconds left. */
  async notify(token: string, id: string): Promise<Row> {
    const { data, error } = await this.supabase.asCaller(token).rpc('notify_tryout', { p_tryout_id: id });
    if (error) {
      if (error.hint === 'notify_cooldown') {
        throw new AppException(429, ErrorCode.RATE_LIMITED, 'Please wait before notifying again.', {
          retryAfterSeconds: error.details,
        });
      }
      throw mapPostgrestError(error, 'notify_tryout');
    }
    return data as Row;
  }
}

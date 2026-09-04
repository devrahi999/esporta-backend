import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

const SPONSORSHIP_SELECT = `
  id, sponsor_id, sponsee_id, application_id, started_at, ended_at,
  sponsor:identities!sponsorships_sponsor_id_fkey(display_name, username, avatar_url, kind, verified),
  sponsee:identities!sponsorships_sponsee_id_fkey(display_name, username, avatar_url, kind, verified)
`;

type Row = Record<string, unknown>;

/**
 * Live sponsorships, both directions.
 *
 * Deliberately not part of the roster: a sponsor holds no team role, takes no
 * slot, and a creator may sponsor several profiles at once — which is the thing
 * `enforce_single_team` exists to forbid for membership. So it is its own table,
 * with rows created only by accepting the sponsorship application that asked for
 * one (`accept_application`) and ended only through `end_sponsorship`, which
 * checks `can_act_as` on both sides and moves the sponsor's availability back.
 *
 * There is no create path here on purpose. `sponsorships` has no INSERT policy,
 * so the only way in is the application — which is what keeps a sponsorship
 * something both sides agreed to.
 */
@Injectable()
export class SponsorshipsService {
  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Sponsorships either side of [identityId]. Public, like roster membership —
   * a sponsorship is something both profiles display.
   */
  list(token: string, identityId: string, includeEnded = false): Promise<Row[]> {
    const client = this.supabase.asCaller(token);
    let query = client
      .from('sponsorships')
      .select(SPONSORSHIP_SELECT)
      .or(`sponsor_id.eq.${identityId},sponsee_id.eq.${identityId}`)
      .order('started_at', { ascending: false });
    if (!includeEnded) query = query.is('ended_at', null);
    return this.supabase.run<Row[]>(query);
  }

  /** Either side may end it; `end_sponsorship` decides which side the caller is. */
  end(token: string, id: string): Promise<Row> {
    return this.supabase.rpcAsCaller<Row>(token, 'end_sponsorship', {
      p_sponsorship: id,
    });
  }
}

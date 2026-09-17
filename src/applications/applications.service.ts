import { Injectable } from '@nestjs/common';
import { SupabaseService, mapPostgrestError } from '../supabase/supabase.service';
import { AppException } from '../common/errors/app-exception';
import { describeEligibilityFailure } from '../common/errors/eligibility';

const APPLICATION_SELECT = `
  id, recruitment_id, applicant_id, target_id, kind, message, status, decision_note,
  decided_at, stage, created_at, hidden_for_applicant_at, hidden_for_target_at,
  applicant:identities!applications_applicant_id_fkey(display_name, username, avatar_url, kind, verified,
    profiles(primary_role_id), teams!teams_id_fkey(category_id)),
  target:identities!applications_target_id_fkey(display_name, username, avatar_url, kind, verified,
    profiles(primary_role_id), teams!teams_id_fkey(category_id)),
  recruitments(post_id, role_id, game_role_slug)
`;
const MESSAGE_SELECT = 'id, application_id, sender_id, kind, message, created_at, read_at';

/**
 * The same select, with the counterparty's `profiles` row inner-joined so a role
 * filter narrows the query instead of the response.
 *
 * Two of them because a queue is read from one side at a time: filtering by "the
 * creators who wrote to me" is a filter on the *applicant*, and "the creators I
 * wrote to" is a filter on the *target*. PostgREST needs the join spelled out per
 * side, so the caller picks.
 */
function roleFilteredSelect(side: 'applicant' | 'target'): string {
  const fk =
    side === 'applicant'
      ? 'applications_applicant_id_fkey'
      : 'applications_target_id_fkey';
  const other = side === 'applicant' ? 'target' : 'applicant';
  const otherFk =
    side === 'applicant'
      ? 'applications_target_id_fkey'
      : 'applications_applicant_id_fkey';
  return `
  id, recruitment_id, applicant_id, target_id, kind, message, status, decision_note,
  decided_at, stage, created_at, hidden_for_applicant_at, hidden_for_target_at,
  ${side}:identities!${fk}(display_name, username, avatar_url, kind, verified,
    profiles!inner(primary_role_id), teams!teams_id_fkey(category_id)),
  ${other}:identities!${otherFk}(display_name, username, avatar_url, kind, verified,
    profiles(primary_role_id), teams!teams_id_fkey(category_id)),
  recruitments(post_id, role_id, game_role_slug)
`;
}

type Row = Record<string, unknown>;

/**
 * Applications (and hires, and sponsorships) with their message thread. RLS
 * returns exactly the rows the caller may see (as applicant or target, personal
 * or managed team); the acting identity is the applicant/sender. Accept is the
 * privileged RPC (rosters + flips availability atomically, and for a sponsorship
 * writes the relationship instead); reject/advance is a guarded update.
 */
@Injectable()
export class ApplicationsService {
  constructor(private readonly supabase: SupabaseService) {}

  /**
   * The caller's queue, narrowed by the query rather than by the client.
   *
   * `kind` and `status` are columns. `role` is the counterparty's role, which
   * lives a table away — so it runs as two inner-joined reads (one per side) and
   * merges them, because a row is "a creator's" whichever column the creator sits
   * in. Both halves are still RLS-scoped, so this can only ever narrow what the
   * caller could already see.
   */
  async list(
    token: string,
    query: { kind?: string; status?: string; role?: string; limit?: number } = {},
  ): Promise<Row[]> {
    const client = this.supabase.asCaller(token);
    const limit = Math.min(Math.max(query.limit ?? 100, 1), 200);

    const apply = (builder: any) => {
      let q = builder.order('created_at', { ascending: false }).limit(limit);
      if (query.kind) q = q.eq('kind', query.kind);
      if (query.status) q = q.eq('status', query.status);
      return q;
    };

    if (!query.role) {
      return this.supabase.run<Row[]>(
        apply(client.from('applications').select(APPLICATION_SELECT)),
      );
    }

    const [asApplicant, asTarget] = await Promise.all([
      this.supabase.run<Row[]>(
        apply(
          client
            .from('applications')
            .select(roleFilteredSelect('applicant'))
            .eq('applicant.profiles.primary_role_id', query.role),
        ),
      ),
      this.supabase.run<Row[]>(
        apply(
          client
            .from('applications')
            .select(roleFilteredSelect('target'))
            .eq('target.profiles.primary_role_id', query.role),
        ),
      ),
    ]);

    // A row where BOTH sides hold the filtered role would come back twice.
    const byId = new Map<string, Row>();
    for (const row of [...asApplicant, ...asTarget]) {
      byId.set(String(row.id), row);
    }
    return [...byId.values()]
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, limit);
  }

  async getById(token: string, id: string): Promise<Row> {
    const client = this.supabase.asCaller(token);
    const row = await this.supabase.run<Row | null>(
      client.from('applications').select(APPLICATION_SELECT).eq('id', id).maybeSingle(),
    );
    if (!row) throw AppException.notFound('Application not found.');
    return row;
  }

  /**
   * Files a request. What pairs of profiles may file which kind is decided in
   * Postgres by `guard_application_capability`, so this maps that refusal into a
   * sentence the app can show instead of a raw constraint message.
   *
   * The check has to live there rather than here: it is a rule about the roles on
   * two other tables, and a trigger covers every write path at once — this API,
   * an RPC, a direct client. Repeating it in TypeScript would be a second answer
   * that could disagree with the first.
   */
  async create(
    token: string,
    applicantId: string,
    dto: { target_id: string; recruitment_id?: string; message?: string; kind: string },
  ): Promise<Row> {
    const client = this.supabase.asCaller(token);
    const payload: Record<string, unknown> = {
      applicant_id: applicantId,
      target_id: dto.target_id,
      kind: dto.kind,
    };
    if (dto.recruitment_id) payload.recruitment_id = dto.recruitment_id;
    if (dto.message && dto.message.trim().length > 0) payload.message = dto.message.trim();
    try {
      return await this.supabase.run<Row>(
        client.from('applications').insert(payload).select(APPLICATION_SELECT).single(),
      );
    } catch (error) {
      throw describeEligibilityFailure(error);
    }
  }

  respond(token: string, id: string, status: string, note?: string): Promise<Row> {
    const client = this.supabase.asCaller(token);
    const patch: Record<string, unknown> = { status };
    if (note !== undefined) patch.decision_note = note;
    return this.supabase.run<Row>(
      client.from('applications').update(patch).eq('id', id).select(APPLICATION_SELECT).single(),
    );
  }

  /** Privileged accept. Maps the `single_team` roster conflict to a clear code. */
  async accept(token: string, id: string, note?: string, addToRoster?: boolean): Promise<Row> {
    const { data, error } = await this.supabase.asCaller(token).rpc('accept_application', {
      p_application_id: id,
      p_note: note ?? null,
      p_add_to_roster: addToRoster ?? false,
    });
    if (error) {
      if (error.hint === 'single_team') {
        throw AppException.conflict('This player is already active on another roster.', 'ROSTER_CONFLICT');
      }
      throw mapPostgrestError(error, 'accept_application');
    }
    return data as Row;
  }

  // ----------------------------------------------------------- messages
  messages(token: string, applicationId: string): Promise<Row[]> {
    const client = this.supabase.asCaller(token);
    return this.supabase.run<Row[]>(
      client.from('application_messages').select(MESSAGE_SELECT).eq('application_id', applicationId).order('created_at'),
    );
  }

  sendMessage(token: string, senderId: string, applicationId: string, kind: string, message: string): Promise<Row> {
    const client = this.supabase.asCaller(token);
    return this.supabase.run<Row>(
      client
        .from('application_messages')
        .insert({ application_id: applicationId, sender_id: senderId, kind, message })
        .select(MESSAGE_SELECT)
        .single(),
    );
  }

  async markMessagesRead(token: string, ids: string[]): Promise<{ updated: number }> {
    if (ids.length === 0) return { updated: 0 };
    const client = this.supabase.asCaller(token);
    await this.supabase.run(
      client.from('application_messages').update({ read_at: new Date().toISOString() }).in('id', ids),
    );
    return { updated: ids.length };
  }

  // -------------------------------------------------------------- hide
  /**
   * "Delete from my list" — per-side, and never a delete.
   *
   * Deliberately an RPC rather than an `update({ hidden_for_… })` here. The
   * `applications update by either side` policy lets either party write the row,
   * so a column name chosen client-side (or in this service) is a column either
   * party could aim at the other. `hide_applications` derives the side from
   * `auth.uid()` per row instead, so hiding somebody else's copy is not
   * expressible rather than merely rejected — and `guard_application_transition`
   * refuses a cross-side write even if some future path tries the plain update.
   *
   * Nothing else moves: status, `decided_*`, the message thread, the
   * counterparty's view, `recruitments.applications_count` and the analytics
   * ledger are all untouched. Withdraw / reject / cancel stay separate routes
   * because they mean something different.
   */
  async hide(token: string, ids: string[]): Promise<{ hidden: number }> {
    if (ids.length === 0) return { hidden: 0 };
    const { data, error } = await this.supabase
      .asCaller(token)
      .rpc('hide_applications', { p_ids: ids });
    if (error) throw mapPostgrestError(error, 'hide_applications');
    return { hidden: typeof data === 'number' ? data : 0 };
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { AppException } from '../common/errors/app-exception';
import { describeEligibilityFailure } from '../common/errors/eligibility';
import type {
  AchievementDto,
  CreateTeamDto,
  SaveTeamProfileDto,
} from './dto/team.dto';

// `following_count` reads through the `visible_following_count` computed column,
// so a team that has hidden its following count sends null to visitors and the
// real number to whoever can act as the team. Same wire key, entitled value.
const TEAM_COLUMNS = `
  id, kind, username, display_name, avatar_url, cover_url, bio, short_bio, country, city,
   verified, created_at, followers_count,
  following_count:visible_following_count, following_count_visible,
  teams!teams_id_fkey!inner(tag, primary_game_id, region, recruiting, founded,
    members_count, owner_id, socials, category_id,
    team_games(game_id, is_primary),
    team_achievements(title, placement, year, sort_order))
`;

const MEMBER_COLUMNS =
  'id, identity_id, role, status, game_role_slug, joined_at, identities!team_members_identity_id_fkey(display_name, username, avatar_url, verified)';

const MEMBER_STATUSES = ['invited', 'requested', 'active'];

/**
 * The two administrative roles on `team_members.role`. Everything else is a
 * roster place — somebody who plays for the profile rather than somebody who
 * administers it — which is why they are named here and checked separately.
 */
const OWNER_ROLE = 'owner';
const ADMIN_ROLE = 'admin';

type Row = Record<string, unknown> & { id: string };

/**
 * Teams. Profile create/edit and owner/lifecycle actions go through the
 * SECURITY DEFINER RPCs (which self-authorise owner/admin via `can_act_as`);
 * membership changes are RLS-guarded direct table ops. Counts are
 * trigger-maintained.
 */
@Injectable()
export class TeamsService {
  private readonly log = new Logger(TeamsService.name);

  constructor(private readonly supabase: SupabaseService) {}

  async getById(token: string, teamId: string): Promise<Row> {
    const client = this.supabase.asCaller(token);
    const team = await this.supabase.run<Row | null>(
      client.from('identities').select(TEAM_COLUMNS).eq('id', teamId).eq('kind', 'team').maybeSingle(),
    );
    if (!team) throw AppException.notFound('Team not found.');
    // Members + the open recruitments the team page shows as "open positions",
    // in one round trip. Matches the app's `IdentityRepository.team` reads so
    // the `_team` mapper builds the roster and openings unchanged.
    //
    // `role_details` rides along for the other-profile categories (News / Media,
    // Tournament Organizer) in the same shape a personal profile carries, so the
    // app has one parser for both.
    const [members, openings, roleDetails] = await Promise.all([
      this.members(token, teamId),
      this.supabase.run<Row[]>(
        client
          .from('recruitments')
          .select('id, game_id, role_id, game_role_slug, min_rank_tier, requirements, slots, deadline')
          .eq('owner_id', teamId)
          .eq('status', 'open')
          .order('created_at', { ascending: false }),
      ),
      this.supabase.rpcAsCaller<Record<string, unknown>>(token, 'identity_role_json', {
        target: teamId,
      }),
    ]);
    return { ...team, members, openings, role_details: roleDetails ?? {} };
  }

  /**
   * The account's team memberships (active + pending join requests) plus how
   * many teams it may still create. Backs the app's identity switcher and team
   * permissions — keyed by the auth user (not the active profile), same as the
   * app's `IdentityController.load`. `team_slots_remaining` is the authoritative
   * count the create trigger enforces.
   */
  async myMemberships(
    token: string,
    userId: string,
  ): Promise<{ memberships: Array<Record<string, unknown>>; slotsRemaining: number }> {
    const client = this.supabase.asCaller(token);
    const [memberships, slotsRemaining] = await Promise.all([
      this.supabase.run<Array<Record<string, unknown>>>(
        client
          .from('team_members')
          .select(
            'role, status, team_id, ' +
              'teams!team_members_team_id_fkey!inner(tag, primary_game_id, region, category_id, ' +
              'identities!teams_id_fkey(display_name, username, avatar_url, verified, status))',
          )
          .eq('identity_id', userId)
          .in('status', ['active', 'requested']),
      ),
      this.supabase.rpcAsCaller<number>(token, 'team_slots_remaining'),
    ]);
    return { memberships, slotsRemaining: slotsRemaining ?? 0 };
  }

  async create(token: string, dto: CreateTeamDto): Promise<Row> {
    const id = await this.supabase.rpcAsCaller<string>(token, 'create_team', {
      p_username: dto.username,
      p_name: dto.name,
      p_tag: dto.tag ?? null,
      p_primary_game_id: dto.primary_game_id ?? null,
      p_region: dto.region ?? null,
      p_bio: dto.bio ?? null,
      p_country: dto.country ?? null,
      p_city: dto.city ?? null,
      p_category_id: dto.category_id ?? 'esports_team',
      p_avatar_url: dto.avatar_url ?? null,
      p_banner_url: dto.banner_url ?? null,
      p_games: dto.games ?? [],
      p_socials: dto.socials ?? {},
      p_achievements: dto.achievements ?? [],
      p_founded: dto.founded ?? null,
    });
    return this.getById(token, id);
  }

  async saveProfile(token: string, teamId: string, patch: SaveTeamProfileDto): Promise<Row> {
    await this.supabase.rpcAsCaller(token, 'save_team_profile', { p_team_id: teamId, patch });
    return this.getById(token, teamId);
  }

  async saveAchievements(token: string, teamId: string, achievements: AchievementDto[]): Promise<{ saved: true }> {
    await this.supabase.rpcAsCaller(token, 'save_team_achievements', {
      p_team_id: teamId,
      p_achievements: achievements,
    });
    return { saved: true };
  }

  async members(token: string, teamId: string): Promise<Row[]> {
    const client = this.supabase.asCaller(token);
    return this.supabase.run<Row[]>(
      client
        .from('team_members')
        .select(MEMBER_COLUMNS)
        .eq('team_id', teamId)
        .in('status', MEMBER_STATUSES)
        .order('role')
        .order('created_at'),
    );
  }

  /**
   * Administrative access to a profile is a privilege change, so it is decided
   * here rather than trusted from the client. The database already self-authorises
   * `can_act_as` (owner OR admin) for ordinary staff work; these three helpers
   * narrow the *privilege-changing* operations the app exposes under Access &
   * Control — adding/removing an admin, transferring ownership, deleting the
   * profile — to the owner, and refuse roster operations for the profile types
   * that have no roster at all.
   */

  /** The caller's own role on [teamId], or null when they have no active seat. */
  private async callerRole(token: string, userId: string, teamId: string): Promise<string | null> {
    const client = this.supabase.asCaller(token);
    const row = await this.supabase.run<Row | null>(
      client
        .from('team_members')
        .select('role')
        .eq('team_id', teamId)
        .eq('identity_id', userId)
        .eq('status', 'active')
        .maybeSingle(),
    );
    return row ? String(row.role) : null;
  }

  private async requireOwner(token: string, userId: string, teamId: string): Promise<void> {
    const role = await this.callerRole(token, userId, teamId);
    if (role !== OWNER_ROLE) {
      throw AppException.forbidden('Only the profile owner can do that.');
    }
  }

  /** Owner or admin — the pair `can_act_as` allows to run a profile's day-to-day. */
  private async requireStaff(token: string, userId: string, teamId: string): Promise<void> {
    const role = await this.callerRole(token, userId, teamId);
    if (role !== OWNER_ROLE && role !== ADMIN_ROLE) {
      throw AppException.forbidden('Only the owner or an admin can do that.');
    }
  }

  /** One `team_members` row, for the guards that have to know what they are touching. */
  private async memberRow(token: string, memberRowId: string): Promise<Row | null> {
    const client = this.supabase.asCaller(token);
    return this.supabase.run<Row | null>(
      client
        .from('team_members')
        .select('id, team_id, identity_id, role, status, invited_by')
        .eq('id', memberRowId)
        .maybeSingle(),
    );
  }

  /** The profile's current owner, read off `teams` rather than off a seat row. */
  private async ownerId(token: string, teamId: string): Promise<string | null> {
    const client = this.supabase.asCaller(token);
    const team = await this.supabase.run<Row | null>(
      client.from('teams').select('owner_id').eq('id', teamId).maybeSingle(),
    );
    const owner = team?.owner_id;
    return typeof owner === 'string' ? owner : null;
  }

  /**
   * Whether the profile's own type has a roster — an Esports Team does, a News /
   * Media outlet, a Tournament Organizer and an Esports Org do not
   * (`team_categories.has_roster`, the same column the app reads through
   * `profile_capability_metadata`).
   *
   * Fails CLOSED: only an explicit `true` allows roster operations. A category
   * that cannot be read (offline, a row in flight, an unknown id) is treated as
   * "no roster", because the downside of wrongly refusing a roster edit is a
   * retry, while the downside of wrongly allowing one on a roster-less profile
   * is members that no screen of that profile type can manage.
   */
  private async hasRoster(token: string, teamId: string): Promise<boolean> {
    const client = this.supabase.asCaller(token);
    try {
      const team = await this.supabase.run<Row | null>(
        client.from('teams').select('category_id').eq('id', teamId).maybeSingle(),
      );
      const categoryId = team?.category_id;
      if (typeof categoryId !== 'string') return false;
      const category = await this.supabase.run<Row | null>(
        client.from('team_categories').select('has_roster').eq('id', categoryId).maybeSingle(),
      );
      return category?.has_roster === true;
    } catch {
      return false;
    }
  }

  private async requireRoster(token: string, teamId: string): Promise<void> {
    if (await this.hasRoster(token, teamId)) return;
    throw AppException.forbidden('This profile type does not have a roster.');
  }

  /**
   * A managed profile is administered by people, not by other profiles, so the
   * person named here has to be a real personal identity that is still live.
   */
  private async requirePersonalIdentity(token: string, identityId: string): Promise<void> {
    const client = this.supabase.asCaller(token);
    const identity = await this.supabase.run<Row | null>(
      client.from('identities').select('kind, status').eq('id', identityId).maybeSingle(),
    );
    if (!identity || identity.kind !== 'personal' || identity.status === 'deleted') {
      throw AppException.validation('Admins have to be personal accounts.');
    }
  }

  /**
   * Invites somebody onto the roster, or into administrative access.
   *
   * Two different things behind one route, because they are the same row in the
   * same state — `team_members` with `status = 'invited'` — and the invitation
   * machinery (accept, decline, the notification trigger, the reminder) is the
   * same for both. What differs is who may ask and what is asked:
   *
   *  * `role = 'admin'` is *administrative access*: Owner-only, and the target
   *    is a personal account. It is deliberately not gated on a roster, because
   *    a News / Media profile has admins too.
   *  * any other role is a *roster place*: it needs the profile type to have a
   *    roster at all, and the database's `guard_team_member_capability` still
   *    decides whether that particular identity may hold one.
   *
   * `owner` is refused outright — ownership moves through `transfer-owner`,
   * which takes the seat away from somebody rather than handing out a second one.
   */
  async invite(
    token: string,
    invitedBy: string,
    teamId: string,
    identityId: string,
    role?: string,
    gameRoleSlug?: string,
  ): Promise<Row> {
    const requestedRole = role ?? 'member';

    // Only the two roles a member seat can hold. `owner` is a transfer, and no
    // other role name the schema might grow later is inviteable until this
    // whitelist learns it deliberately.
    if (requestedRole !== 'member' && requestedRole !== ADMIN_ROLE) {
      throw AppException.validation(
        requestedRole === OWNER_ROLE
          ? 'Ownership is transferred, not invited.'
          : 'Role must be member or admin.',
      );
    }

    if (requestedRole === ADMIN_ROLE) {
      await this.requireOwner(token, invitedBy, teamId);
      // Granting administrative access is a privilege change: the database's
      // `guard_team_member_role` enforces the same 15-minute reauth window on
      // the INSERT, so an expired reauth is surfaced as a 403 before the row is
      // attempted (the DB remains the authority; this is a friendlier error).
      await this.assertFreshReauth(token);
      await this.requirePersonalIdentity(token, identityId);
    } else {
      await this.requireRoster(token, teamId);
    }

    const client = this.supabase.asCaller(token);
    try {
      const row = await this.supabase.run<Row>(
        client
          .from('team_members')
          .insert({
            team_id: teamId,
            identity_id: identityId,
            role: requestedRole,
            status: 'invited',
            invited_by: invitedBy,
            game_role_slug: gameRoleSlug ?? null,
          })
          .select(MEMBER_COLUMNS)
          .single(),
      );
      if (requestedRole === ADMIN_ROLE) {
        await this.logAccess(token, 'team_admin_invited', identityId, {
          team_id: teamId,
          member_row_id: row.id,
        });
      }
      return row;
    } catch (error) {
      throw describeEligibilityFailure(error);
    }
  }

  /**
   * The database's reauth gate raises with a bare message; translating it here
   * keeps the app's error copy in one place. The DB check stays the authority —
   * this only surfaces its verdict.
   */
  private async assertFreshReauth(token: string): Promise<void> {
    const fresh = await this.supabase.rpcAsCaller<boolean>(token, 'reauth_is_fresh');
    if (fresh === false) {
      throw AppException.forbidden('Re-authenticate to manage administrative access.');
    }
  }

  /** Access-control actions land in the existing admin audit trail. */
  private async logAccess(
    token: string,
    action: string,
    targetId: string,
    after: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.supabase.rpcAsCaller(token, 'log_access_action', {
        p_action: action,
        p_target_type: 'identity',
        p_target_id: targetId,
        p_after: after,
      });
    } catch (error) {
      // Audit must never break the user-visible action; the DB trigger-level
      // guards already authorised the underlying change. It is logged rather
      // than swallowed, because a silently dead audit trail is worse than a
      // noisy one — which is exactly how this call went unnoticed while the
      // database function could not be written to at all.
      this.log.warn(`access audit write failed (${action}): ${String(error)}`);
    }
  }

  async requestToJoin(token: string, teamId: string, identityId: string): Promise<{ requested: true }> {
    const client = this.supabase.asCaller(token);
    try {
      await this.supabase.run(
        client
          .from('team_members')
          .upsert(
            { team_id: teamId, identity_id: identityId, role: 'member', status: 'requested' },
            { onConflict: 'team_id,identity_id' },
          ),
      );
    } catch (error) {
      throw describeEligibilityFailure(error);
    }
    return { requested: true };
  }

  /**
   * Answers a membership row: marks it `active`.
   *
   * Two callers, one row, one state, so one route. The RLS policy already allows
   * only the invited person or the profile's staff here; these checks say the same
   * thing out loud, because a hand-crafted request naming somebody else's
   * invitation must be refused by name rather than by a silently-empty update:
   *
   *  * answering your own invitation — always yours to answer;
   *  * approving somebody else's request or invitation — staff work, and an
   *    *admin* invitation is the owner's alone;
   *  * an admin invitation whose inviter is no longer the profile's owner is
   *    stale: ownership moved since it was sent, so the authority behind it is
   *    gone and it has to be re-issued by whoever owns the profile now.
   */
  async acceptMember(token: string, userId: string, memberRowId: string): Promise<Row> {
    const row = await this.memberRow(token, memberRowId);
    if (!row) throw AppException.notFound('That invitation is no longer valid.');

    const status = String(row.status);
    if (status !== 'invited' && status !== 'requested') {
      throw AppException.conflict('That invitation is no longer valid.');
    }

    const teamId = String(row.team_id);
    const isAdminSeat = String(row.role) === ADMIN_ROLE;

    if (row.identity_id !== userId) {
      if (isAdminSeat) await this.requireOwner(token, userId, teamId);
      else await this.requireStaff(token, userId, teamId);
    }

    if (isAdminSeat && row.identity_id === userId) {
      const owner = await this.ownerId(token, teamId);
      if (owner != null && row.invited_by !== owner) {
        throw AppException.conflict('That invitation is no longer valid.');
      }
    }

    const client = this.supabase.asCaller(token);
    try {
      const updated = await this.supabase.run<Row>(
        client
          .from('team_members')
          .update({ status: 'active', joined_at: new Date().toISOString() })
          .eq('id', memberRowId)
          .select(MEMBER_COLUMNS)
          .single(),
      );
      if (isAdminSeat) {
        await this.logAccess(
          token,
          'team_admin_accepted',
          String(row.identity_id),
          { team_id: teamId, member_row_id: memberRowId },
        );
      }
      return updated;
    } catch (error) {
      throw describeEligibilityFailure(error);
    }
  }

  /**
   * Removes a membership row, or answers an invitation by deleting it.
   *
   * Three cases, deliberately not one:
   *  * the caller's own row — declining an invitation, withdrawing a request;
   *  * somebody else's *roster* row — staff work, owner or admin, which is what
   *    the roster screen does today;
   *  * somebody else's *administrative access* — owner only: an admin does not
   *    decide who else becomes an admin.
   *
   * The owner's seat is never removable here. Ownership changes through
   * `transfer-owner`, so a profile can never be left without one.
   */
  async removeMember(token: string, userId: string, memberRowId: string): Promise<{ removed: true }> {
    const row = await this.memberRow(token, memberRowId);
    if (!row) throw AppException.notFound('That member is no longer on this profile.');

    const teamId = String(row.team_id);
    const targetRole = String(row.role);

    if (targetRole === OWNER_ROLE) {
      throw AppException.forbidden('Ownership has to be transferred before it can change hands.');
    }

    if (row.identity_id !== userId) {
      if (targetRole === ADMIN_ROLE) {
        await this.requireOwner(token, userId, teamId);
        await this.assertFreshReauth(token);
      } else {
        await this.requireStaff(token, userId, teamId);
      }
    }

    const client = this.supabase.asCaller(token);
    await this.supabase.run(client.from('team_members').delete().eq('id', memberRowId));
    if (targetRole === ADMIN_ROLE && row.identity_id !== userId) {
      // The removed admin is notified by the membership trigger
      // (admin_access_removed); this records the owner's act in the audit trail.
      await this.logAccess(token, 'team_admin_removed', String(row.identity_id), {
        team_id: teamId,
        member_row_id: memberRowId,
      });
    }
    return { removed: true };
  }

  /**
   * Moves a seat between roster and admin.
   *
   * `owner` is refused — a second owner is not a role, it is a transfer. Giving
   * somebody administrative access is the owner's call; moving a roster place
   * around stays staff work, and only where the profile type *has* a roster.
   */
  async setMemberRole(token: string, userId: string, memberRowId: string, role: string): Promise<Row> {
    // Only the two roles a member seat can hold; `owner` is a transfer.
    if (role !== 'member' && role !== ADMIN_ROLE) {
      throw AppException.validation(
        role === OWNER_ROLE
          ? 'Ownership is transferred, not assigned.'
          : 'Role must be member or admin.',
      );
    }

    const row = await this.memberRow(token, memberRowId);
    if (!row) throw AppException.notFound('That member is no longer on this profile.');

    if (String(row.role) === OWNER_ROLE) {
      throw AppException.forbidden('The owner keeps their seat until ownership is transferred.');
    }

    const teamId = String(row.team_id);
    const grant = role === ADMIN_ROLE && String(row.role) !== ADMIN_ROLE;
    if (grant) {
      await this.requireOwner(token, userId, teamId);
      await this.assertFreshReauth(token);
    } else if (role === ADMIN_ROLE) {
      await this.requireOwner(token, userId, teamId);
    } else {
      await this.requireStaff(token, userId, teamId);
      await this.requireRoster(token, teamId);
    }

    const client = this.supabase.asCaller(token);
    const updated = await this.supabase.run<Row>(
      client.from('team_members').update({ role }).eq('id', memberRowId).select(MEMBER_COLUMNS).single(),
    );
    if (grant) {
      await this.logAccess(token, 'team_admin_invited', String(row.identity_id), {
        team_id: teamId,
        member_row_id: memberRowId,
        via: 'role_change',
      });
    }
    return updated;
  }

  async leave(token: string, teamId: string): Promise<{ left: true }> {
    await this.supabase.rpcAsCaller(token, 'leave_team', { p_team_id: teamId });
    return { left: true };
  }

  /**
   * Hands the profile to somebody else. Owner-only, and the target has to be a
   * live *personal* account: a managed profile cannot own another one, which is
   * the same rule the admin invitation follows. `transfer_team_ownership` moves
   * the seat; this is the sentence that says who is allowed to ask.
   */
  async transferOwner(
    token: string,
    userId: string,
    teamId: string,
    newOwner: string,
  ): Promise<{ transferred: true }> {
    await this.requireOwner(token, userId, teamId);
    await this.assertFreshReauth(token);
    if (newOwner === userId) {
      throw AppException.validation('You are already the owner of this profile.');
    }
    await this.requirePersonalIdentity(token, newOwner);
    await this.supabase.rpcAsCaller(token, 'transfer_team_ownership', {
      p_team_id: teamId,
      p_new_owner: newOwner,
    });
    await this.logAccess(token, 'ownership_transferred', newOwner, {
      team_id: teamId,
    });
    return { transferred: true };
  }

  /**
   * Ends the profile. Owner-only, checked here as well as inside `delete_team`,
   * which is the RPC that actually performs the deletion and requires a fresh
   * re-authentication of the owner.
   *
   * Media is purged through the existing cleanup queue: `purge_team_media`
   * enqueues every provider object the profile owns (R2 / Stream / Supabase
   * Storage), and the async drainer empties it. Failures there are retried with
   * backoff and never block the deletion itself — the soft delete runs first,
   * so the profile is gone from the app immediately either way. Cloudinary rows
   * (legacy provider, credentials no longer configured) resolve as skipped in
   * the drainer with a recorded reason.
   */
  async delete(token: string, userId: string, teamId: string): Promise<{ deleted: true }> {
    await this.requireOwner(token, userId, teamId);
    // purge_team_media re-checks ownership + reauth; calling it first means an
    // expired reauth never soft-deletes the profile while its media lingers.
    await this.supabase.rpcAsCaller(token, 'purge_team_media', { p_team_id: teamId });
    await this.supabase.rpcAsCaller(token, 'delete_team', { p_team_id: teamId });
    await this.logAccess(token, 'team_deleted', teamId, {});
    return { deleted: true };
  }
}

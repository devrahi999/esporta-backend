import { Injectable } from '@nestjs/common';
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

type Row = Record<string, unknown> & { id: string };

/**
 * Teams. Profile create/edit and owner/lifecycle actions go through the
 * SECURITY DEFINER RPCs (which self-authorise owner/admin via `can_act_as`);
 * membership changes are RLS-guarded direct table ops. Counts are
 * trigger-maintained.
 */
@Injectable()
export class TeamsService {
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
   * Invites somebody onto the roster.
   *
   * Whether they MAY hold a roster place is `guard_team_member_capability`'s
   * decision — a caster and a creator cannot, so the row is refused whatever
   * asked for it. That refusal is renamed here so the app shows a sentence rather
   * than a constraint name. A creator is invited as a *sponsor* through the
   * sponsorship application instead, which produces no membership row at all.
   */
  async invite(
    token: string,
    invitedBy: string,
    teamId: string,
    identityId: string,
    role?: string,
    gameRoleSlug?: string,
  ): Promise<Row> {
    const client = this.supabase.asCaller(token);
    try {
      return await this.supabase.run<Row>(
        client
          .from('team_members')
          .insert({
            team_id: teamId,
            identity_id: identityId,
            role: role ?? 'member',
            status: 'invited',
            invited_by: invitedBy,
            game_role_slug: gameRoleSlug ?? null,
          })
          .select(MEMBER_COLUMNS)
          .single(),
      );
    } catch (error) {
      throw describeEligibilityFailure(error);
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

  async acceptMember(token: string, memberRowId: string): Promise<Row> {
    const client = this.supabase.asCaller(token);
    try {
      return await this.supabase.run<Row>(
        client
          .from('team_members')
          .update({ status: 'active', joined_at: new Date().toISOString() })
          .eq('id', memberRowId)
          .select(MEMBER_COLUMNS)
          .single(),
      );
    } catch (error) {
      throw describeEligibilityFailure(error);
    }
  }

  async removeMember(token: string, memberRowId: string): Promise<{ removed: true }> {
    const client = this.supabase.asCaller(token);
    await this.supabase.run(client.from('team_members').delete().eq('id', memberRowId));
    return { removed: true };
  }

  async setMemberRole(token: string, memberRowId: string, role: string): Promise<Row> {
    const client = this.supabase.asCaller(token);
    return this.supabase.run<Row>(
      client.from('team_members').update({ role }).eq('id', memberRowId).select(MEMBER_COLUMNS).single(),
    );
  }

  async leave(token: string, teamId: string): Promise<{ left: true }> {
    await this.supabase.rpcAsCaller(token, 'leave_team', { p_team_id: teamId });
    return { left: true };
  }

  async transferOwner(token: string, teamId: string, newOwner: string): Promise<{ transferred: true }> {
    await this.supabase.rpcAsCaller(token, 'transfer_team_ownership', {
      p_team_id: teamId,
      p_new_owner: newOwner,
    });
    return { transferred: true };
  }

  async delete(token: string, teamId: string): Promise<{ deleted: true }> {
    await this.supabase.rpcAsCaller(token, 'delete_team', { p_team_id: teamId });
    return { deleted: true };
  }
}

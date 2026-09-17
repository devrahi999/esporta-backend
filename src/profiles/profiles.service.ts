import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { AppException } from '../common/errors/app-exception';
import type { SaveProfileDto, UserGameDto } from './dto/profile.dto';

type Json = Record<string, unknown>;

// The public profile *card* shape — identity + profile + current team — matching
// the app's `IdentityRepository._player` select, so viewing another player's
// profile returns exactly what that mapper consumes. Unlike `profile_json`, it
// carries no private fields (email, setup flags) and adds the current-team
// membership the marketplace card shows.
//
// `following_count` is read through the `visible_following_count` computed column
// rather than the raw counter, so a profile that has hidden it sends null to
// everyone but its own owner. The key on the wire is unchanged; the value is the
// one the reader is entitled to. `following_count_visible` rides along so the app
// can tell "hidden" from "follows nobody" and render nothing instead of a zero.
const CARD_COLUMNS =
  'id, kind, username, display_name, avatar_url, cover_url, bio, short_bio, country, city, ' +
  ' verified, created_at, followers_count, ' +
  'following_count:visible_following_count, following_count_visible, ' +
  'profiles!inner(primary_role_id, availability, socials, languages, profile_views, ' +
  'user_games(game_id, ign, role, rank, is_primary)), ' +
  'team_members!team_members_identity_id_fkey(status, team_id, ' +
  'teams!team_members_team_id_fkey(tag, primary_game_id, ' +
  'identities!teams_id_fkey(display_name, username, avatar_url)))';

/**
 * Personal profile reads/writes. Reads go through `profile_json` (the same
 * shaped payload the app consumes); writes through `save_profile`, which routes
 * the patch to `identities`/`profiles` server-side keyed by `auth.uid()`. Team
 * profiles are handled by the Teams module.
 */
@Injectable()
export class ProfilesService {
  constructor(private readonly supabase: SupabaseService) {}

  async getById(accessToken: string, identityId: string): Promise<Json> {
    const row = await this.supabase.rpcAsCaller<Json | null>(accessToken, 'profile_json', {
      target: identityId,
    });
    if (!row) throw AppException.notFound('Profile not found.');
    return row;
  }

  /**
   * A public profile card for any personal identity — the shape the app's
   * `_player` mapper reads. Distinct from {@link getById}/`profile_json` (the
   * caller's own editable profile): this omits private fields and adds the
   * current-team membership the marketplace card shows.
   */
  async card(accessToken: string, identityId: string): Promise<Json> {
    const client = this.supabase.asCaller(accessToken);
    const [row, roleDetails] = await Promise.all([
      this.supabase.run<Json | null>(
        client
          .from('identities')
          .select(CARD_COLUMNS)
          .eq('id', identityId)
          .eq('kind', 'personal')
          .maybeSingle(),
      ),
      // Role-specific data (Coach, Manager, Analyst, Creator, Caster), read
      // through the same RPC `profile_json` uses so both payloads carry an
      // identical `role_details` shape. A second round trip rather than a
      // PostgREST embed: it is one call, it runs in parallel, and the app parses
      // one thing from every profile read.
      this.supabase.rpcAsCaller<Json>(accessToken, 'identity_role_json', {
        target: identityId,
      }),
    ]);
    if (!row) throw AppException.notFound('Profile not found.');
    return { ...row, role_details: roleDetails ?? {} };
  }

  async save(accessToken: string, patch: SaveProfileDto): Promise<Json> {
    return this.supabase.rpcAsCaller<Json>(accessToken, 'save_profile', { patch });
  }

  /**
   * Sets whether other people may see this identity's following count.
   *
   * The RPC authorises itself with `can_act_as`, which is why this takes an
   * identity id rather than reading the caller's: a team owner changing their
   * team's preference is the same call as a player changing their own, and the
   * one place that decides who may is Postgres.
   */
  async setFollowingCountVisible(
    accessToken: string,
    identityId: string,
    visible: boolean,
  ): Promise<{ following_count_visible: boolean }> {
    const stored = await this.supabase.rpcAsCaller<boolean>(
      accessToken,
      'set_following_count_visible',
      { p_identity: identityId, p_visible: visible },
    );
    return { following_count_visible: stored === true };
  }

  /**
   * Whether `candidate` is free.
   *
   * Answered with the anon key rather than the caller's token, because it must
   * work with no caller at all: the signup screen checks a handle *before* the
   * account exists. `username_available` is SECURITY DEFINER, already granted to
   * `anon`, and reads nothing but the `identities` handle column — so the verdict
   * does not depend on who asks, and this is no more privileged than the app
   * hitting the RPC directly with the anon key.
   */
  async usernameAvailable(candidate: string): Promise<boolean> {
    const ok = await this.supabase.rpcAsAnon<boolean>('username_available', {
      candidate,
    });
    return ok === true;
  }

  /**
   * Replaces the caller's game list wholesale (delete + insert), matching the
   * app's editor. RLS ties `user_games.user_id` to the owner.
   */
  async replaceGames(accessToken: string, userId: string, games: UserGameDto[]): Promise<Json[]> {
    const client = this.supabase.asCaller(accessToken);
    await this.supabase.run(client.from('user_games').delete().eq('user_id', userId));
    if (games.length === 0) return [];
    const rows = games.map((g) => ({
      user_id: userId,
      game_id: g.game_id,
      ign: g.ign,
      game_uid: g.game_uid ?? null,
      role: g.role ?? null,
      rank: g.rank ?? null,
      is_primary: g.is_primary ?? false,
    }));
    return this.supabase.run(
      client
        .from('user_games')
        .insert(rows)
        .select('game_id, ign, game_uid, role, rank, is_primary'),
    );
  }
}

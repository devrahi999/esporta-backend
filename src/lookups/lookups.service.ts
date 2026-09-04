import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { isUuid } from '../common/utils/uuid';

type Row = Record<string, unknown>;

/**
 * Reference data (games, roles, ranks, report reasons, team categories, post
 * types) and the custom-entry registration RPCs. Games/roles include the caller's
 * own custom entries (`created_by`) alongside the active catalogue, matching the
 * app.
 *
 * `roles` and `team_categories` are selected with `*`, so the capability columns
 * (`can_join_team`, `can_tryout`, `has_achievements`, `can_sponsor`,
 * `can_be_sponsored`, `availability_mode`, `has_roster`, `has_availability`) reach
 * the client with no per-column maintenance here. That is deliberate: the app
 * mirrors those flags to decide what to offer, and Postgres triggers enforce them,
 * so both read one row.
 */
@Injectable()
export class LookupsService {
  constructor(private readonly supabase: SupabaseService) {}

  /**
   * The catalogue, as the caller is entitled to see it.
   *
   * Both arguments are optional because this route serves signed-out callers —
   * the app reads it during startup for the login and signup screens. With no
   * token it runs as `anon`, which RLS already grants SELECT on all seven tables,
   * and the `created_by` half of the `or` matches nothing. With a token it runs as
   * that caller, which is what surfaces their own inactive custom entries.
   */
  async all(token?: string, userId?: string): Promise<Record<string, Row[]>> {
    const client = token ? this.supabase.asCaller(token) : this.supabase.anon();
    // A sentinel rather than a branch on the `or` filter: `created_by` is a uuid
    // column, so an empty string would be a malformed filter, and the nil uuid
    // simply matches no row.
    const mine = isUuid(userId) ? userId : '00000000-0000-0000-0000-000000000000';

    const [games, roles, gameRoles, gameRanks, reportReasons, teamCategories, postTypes] =
      await Promise.all([
        this.supabase.run<Row[]>(
          client.from('games').select('*').or(`active.eq.true,created_by.eq.${mine}`).order('sort_order'),
        ),
        this.supabase.run<Row[]>(
          client.from('roles').select('*').or(`active.eq.true,created_by.eq.${mine}`).order('sort_order'),
        ),
        this.supabase.run<Row[]>(client.from('game_roles').select('*').order('sort_order')),
        this.supabase.run<Row[]>(client.from('game_ranks').select('*').order('tier')),
        this.supabase.run<Row[]>(
          client.from('report_reasons').select('*').eq('active', true).order('sort_order'),
        ),
        this.supabase.run<Row[]>(
          client.from('team_categories').select('*').eq('active', true).order('sort_order'),
        ),
        // The composer's type picker reads this rather than a list in Dart, so a
        // new recruitment type is a row and the label a user sees is the
        // catalogue's own.
        this.supabase.run<Row[]>(
          client.from('post_types').select('*').eq('active', true).order('sort_order'),
        ),
      ]);

    return { games, roles, gameRoles, gameRanks, reportReasons, teamCategories, postTypes };
  }

  registerGame(token: string, name: string): Promise<string> {
    return this.supabase.rpcAsCaller<string>(token, 'register_custom_game', { p_name: name });
  }

  /**
   * Retired as a product path. A professional role decides what a profile is
   * permitted to do and is immutable once saved, so it has to come from the
   * official catalogue — `profiles_guard_official_role` refuses a custom one
   * whatever writes it, which makes a role registered here unusable as a profile
   * role. Kept only so an older client calling it still gets a clean answer
   * rather than a 404.
   */
  registerRole(token: string, label: string): Promise<string> {
    return this.supabase.rpcAsCaller<string>(token, 'register_custom_role', { p_label: label });
  }

  registerGameRole(token: string, gameId: string, label: string): Promise<string> {
    return this.supabase.rpcAsCaller<string>(token, 'register_custom_game_role', {
      p_game_id: gameId,
      p_label: label,
    });
  }
}

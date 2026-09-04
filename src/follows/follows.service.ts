import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { AppException } from '../common/errors/app-exception';
import { clampLimit } from '../common/dto/pagination.dto';

const FOLLOWER_JOIN =
  'id, kind, display_name, username, avatar_url, verified, status';

type Row = Record<string, unknown>;

/**
 * Follow graph. Counters (`followers_count`/`following_count`) are
 * trigger-maintained; the acting profile is the follower. Deleted identities are
 * dropped from list results.
 */
@Injectable()
export class FollowsService {
  constructor(private readonly supabase: SupabaseService) {}

  async follow(token: string, followerId: string, followeeId: string): Promise<{ following: true }> {
    if (followerId === followeeId) {
      throw AppException.badRequest('You cannot follow yourself.');
    }
    const client = this.supabase.asCaller(token);
    await this.supabase.run(
      client
        .from('follows')
        .upsert(
          { follower_id: followerId, followee_id: followeeId },
          { onConflict: 'follower_id,followee_id', ignoreDuplicates: true },
        ),
    );
    return { following: true };
  }

  async unfollow(token: string, followerId: string, followeeId: string): Promise<{ following: false }> {
    const client = this.supabase.asCaller(token);
    await this.supabase.run(
      client.from('follows').delete().eq('follower_id', followerId).eq('followee_id', followeeId),
    );
    return { following: false };
  }

  async myFollowingIds(token: string, followerId: string): Promise<string[]> {
    const client = this.supabase.asCaller(token);
    const rows = await this.supabase.run<Array<{ followee_id: string }>>(
      client.from('follows').select('followee_id').eq('follower_id', followerId),
    );
    return rows.map((r) => r.followee_id);
  }

  async followers(token: string, identityId: string, limit?: number): Promise<Row[]> {
    const take = clampLimit(limit, 200, 200);
    const client = this.supabase.asCaller(token);
    const rows = await this.supabase.run<Array<{ created_at: string; follower: Row | null }>>(
      client
        .from('follows')
        .select(`follower_id, created_at, follower:identities!follows_follower_id_fkey(${FOLLOWER_JOIN})`)
        .eq('followee_id', identityId)
        .order('created_at', { ascending: false })
        .limit(take),
    );
    return this.pluck(rows, 'follower');
  }

  async following(token: string, identityId: string, limit?: number): Promise<Row[]> {
    const take = clampLimit(limit, 200, 200);
    const client = this.supabase.asCaller(token);
    const rows = await this.supabase.run<Array<{ created_at: string; followee: Row | null }>>(
      client
        .from('follows')
        .select(`followee_id, created_at, followee:identities!follows_followee_id_fkey(${FOLLOWER_JOIN})`)
        .eq('follower_id', identityId)
        .order('created_at', { ascending: false })
        .limit(take),
    );
    return this.pluck(rows, 'followee');
  }

  private pluck(rows: Array<Record<string, unknown>>, key: string): Row[] {
    return rows
      .map((r) => r[key] as Row | null)
      .filter((i): i is Row => !!i && i.status !== 'deleted');
  }
}

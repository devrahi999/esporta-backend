import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { AppException } from '../common/errors/app-exception';
import type { CreateRecruitmentDto } from './dto/recruitment.dto';

type Row = Record<string, unknown>;

/**
 * Recruitment openings. A recruitment is owned by the acting identity (team) and
 * attached to an advertising post. Status transitions go through
 * `set_recruitment_status` (which guards open/closed and sets `filled`
 * server-side on accept); counts are trigger-maintained.
 */
@Injectable()
export class RecruitmentService {
  constructor(private readonly supabase: SupabaseService) {}

  async create(token: string, ownerId: string, dto: CreateRecruitmentDto): Promise<Row> {
    const client = this.supabase.asCaller(token);
    const row: Record<string, unknown> = { owner_id: ownerId, post_id: dto.post_id };
    for (const key of [
      'game_id', 'role_id', 'game_role_slug', 'region', 'country', 'city',
      'min_rank_tier', 'max_rank_tier', 'min_age', 'max_age', 'availability',
      'requirements', 'slots', 'deadline',
    ] as const) {
      const value = (dto as unknown as Record<string, unknown>)[key];
      if (value !== undefined) row[key] = value;
    }
    return this.supabase.run<Row>(client.from('recruitments').insert(row).select('*').single());
  }

  async getById(token: string, id: string): Promise<Row> {
    const client = this.supabase.asCaller(token);
    const row = await this.supabase.run<Row | null>(
      client.from('recruitments').select('*').eq('id', id).maybeSingle(),
    );
    if (!row) throw AppException.notFound('Recruitment not found.');
    return row;
  }

  async list(token: string, ownerId: string, status?: string): Promise<Row[]> {
    const client = this.supabase.asCaller(token);
    let query = client.from('recruitments').select('*').eq('owner_id', ownerId);
    if (status) query = query.eq('status', status);
    return this.supabase.run<Row[]>(query.order('created_at', { ascending: false }));
  }

  setStatus(token: string, id: string, status: string): Promise<Row> {
    return this.supabase.rpcAsCaller<Row>(token, 'set_recruitment_status', {
      p_recruitment: id,
      p_status: status,
    });
  }
}

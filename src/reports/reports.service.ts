import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { AppException } from '../common/errors/app-exception';
import { PlatformPolicyService } from '../platform/platform-policy.service';

@Injectable()
export class ReportsService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly platform: PlatformPolicyService,
  ) {}

  async submit(token: string, reporterId: string, surface: string, targetId: string, reasonId: string, details?: string) {
    // A suspended account may not file reports either (Part 4: suspension
    // blocks normal protected activity). Reporting is otherwise never gated
    // by feature switches — a report is a moderation signal, not content.
    await this.platform.assertNotSuspended(reporterId);

    const { error } = await this.supabase.asCaller(token).from('reports').insert({
      reporter_id: reporterId,
      target_type: surface,
      target_id: targetId,
      reason_id: reasonId,
      details: details || null,
    });

    if (error) {
      if (error.code === '23505') throw AppException.conflict('Already reported.');
      throw AppException.upstream('Could not submit report.', error);
    }
    return { success: true };
  }
}

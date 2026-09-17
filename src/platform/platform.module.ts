import { Module } from '@nestjs/common';
import { SupabaseModule } from '../supabase/supabase.module';
import { AuthModule } from '../auth/auth.module';
import { PlatformPolicyService } from './platform-policy.service';
import { PlatformController } from './platform.controller';

/**
 * Platform-level policy: the control board (maintenance + feature gates),
 * the per-user restriction evaluation, and the effective-state endpoint the
 * app bootstrap reads (plan Parts 3, 16, 17).
 *
 * `AuthModule` is imported for OptionalAuthGuard (the state endpoint is
 * `@Public()` but richer when a valid token is present). Enforcement is NOT a
 * Nest guard: the write paths (posts.create, media sessions, comments.add,
 * reports.submit) call PlatformPolicyService directly, because each needs a
 * different feature key and a different friendly message — a declarative
 * guard could not express that.
 */
@Module({
  imports: [SupabaseModule, AuthModule],
  controllers: [PlatformController],
  providers: [PlatformPolicyService],
  exports: [PlatformPolicyService],
})
export class PlatformModule {}

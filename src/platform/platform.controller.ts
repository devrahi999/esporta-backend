import { Controller, Get, UseGuards } from '@nestjs/common';
import { OptionalAccessToken, OptionalUserId } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { OptionalAuthGuard } from '../auth/guards/optional-auth.guard';
import { PlatformPolicyService } from './platform-policy.service';

/**
 * The platform-state surface the app bootstrap reads (Part 16): maintenance
 * flag + feature gates, and — when signed in — the caller's effective gates
 * (global + personal restrictions folded together, most-restrictive-wins).
 *
 * Signed-out callers still get the global state: the maintenance screen must
 * be renderable before any auth round trip.
 */
@Public()
@UseGuards(OptionalAuthGuard)
@Controller('platform')
export class PlatformController {
  constructor(private readonly policy: PlatformPolicyService) {}

  @Get('state')
  state(@OptionalAccessToken() token: string | undefined, @OptionalUserId() userId: string | undefined) {
    return this.policy.effectiveFor(userId ?? null);
  }
}

import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AdminService } from './admin.service';
import { AdminGuard } from './guards/admin.guard';
import { AccessToken } from '../common/decorators/current-user.decorator';
import { PlatformPolicyService } from '../platform/platform-policy.service';
import { AppException } from '../common/errors/app-exception';
import { isUuid } from '../common/utils/uuid';
import { AdminRecentPostsQuery, SetPlatformControlDto, SetSuspendedDto, SetUserRestrictionDto } from './dto/admin.dto';

/**
 * `/api/v1/admin` — platform controls, per-user restrictions and the
 * post-publication moderation queue (plan Parts 3, 4, 5).
 *
 * Authorization is enforced twice: AdminGuard at the door, then each RPC's own
 * `admin_require(capability)` in the database. Control flips additionally
 * invalidate the backend's cached platform state so enforcement is immediate.
 */
@Controller('admin')
@UseGuards(AdminGuard)
export class AdminPlatformController {
  constructor(
    private readonly admin: AdminService,
    private readonly platform: PlatformPolicyService,
  ) {}

  private uuid(id: string, label = 'id'): void {
    if (!isUuid(id)) throw AppException.validation(`Invalid ${label}.`);
  }

  // ---- platform controls ----
  @Get('platform/controls')
  controls(@AccessToken() t: string) {
    return this.admin.platformControls(t);
  }

  @Post('platform/controls/:key')
  setControl(
    @AccessToken() t: string,
    @Param('key') key: string,
    @Body() dto: SetPlatformControlDto,
  ) {
    if (!['maintenance', 'upload_images', 'upload_videos', 'upload_shorts', 'post_creation', 'comments'].includes(key)) {
      throw AppException.validation('Unknown platform control.');
    }
    return this.admin.setPlatformControl(t, key, dto).then((result) => {
      this.platform.invalidateCache();
      return result;
    });
  }

  // ---- per-user restrictions & suspension ----
  @Get('users/:id/restrictions')
  userRestrictions(@AccessToken() t: string, @Param('id') id: string) {
    this.uuid(id, 'identity id');
    return this.admin.userRestrictions(t, id);
  }

  @Post('users/:id/restrictions')
  setUserRestriction(
    @AccessToken() t: string,
    @Param('id') id: string,
    @Body() dto: SetUserRestrictionDto,
  ) {
    this.uuid(id, 'identity id');
    return this.admin.setUserRestriction(t, id, dto);
  }

  @Post('users/:id/suspend')
  setSuspended(
    @AccessToken() t: string,
    @Param('id') id: string,
    @Body() dto: SetSuspendedDto,
  ) {
    this.uuid(id, 'identity id');
    return this.admin.setSuspended(t, id, dto);
  }

  // ---- post-publication moderation queue (Part 5) ----
  @Get('moderation/uploads')
  uploads(@AccessToken() t: string, @Query() q: AdminRecentPostsQuery) {
    return this.admin.postsRecent(t, q);
  }

  @Get('moderation/stats')
  stats(@AccessToken() t: string) {
    return this.admin.moderationStats(t);
  }
}

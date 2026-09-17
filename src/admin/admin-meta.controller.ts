import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { AdminService } from './admin.service';
import { AdminGuard } from './guards/admin.guard';
import { AccessToken } from '../common/decorators/current-user.decorator';
import {
  AdminAuditQuery,
  AdminNotificationsQuery,
  AdminTimeseriesQuery,
  AnnounceDto,
  SendNotificationDto,
} from './dto/admin.dto';

/**
 * `/api/v1/admin` — operations metadata: dashboards, settings, ops overviews,
 * the audit log, and the outbound notification surface.
 *
 * These ten operations already existed on {@link AdminService} but had no
 * controller binding, which left `core-admin` with no REST route to call for its
 * dashboard, settings, storage, notifications and audit-log pages. Binding them
 * here — rather than adding a generic `POST /admin/rpc` passthrough — keeps the
 * rule that the admin API only ever exposes named, validated operations, and
 * never arbitrary database RPC execution.
 *
 * A separate controller (instead of growing the three existing ones) keeps the
 * already-verified user/content/support surfaces untouched. Nest allows several
 * controllers on one prefix; none of these paths collide with a `:param` route
 * on the others.
 */
@Controller('admin')
@UseGuards(AdminGuard)
export class AdminMetaController {
  constructor(private readonly admin: AdminService) {}

  // ---- dashboards / ops overviews ----
  @Get('dashboard') dashboard(@AccessToken() t: string) { return this.admin.dashboard(t); }

  @Get('timeseries') timeseries(@AccessToken() t: string, @Query() q: AdminTimeseriesQuery) {
    return this.admin.timeseries(t, q.days);
  }

  @Get('settings') settings(@AccessToken() t: string) { return this.admin.settings(t); }

  @Get('storage-overview') storage(@AccessToken() t: string) { return this.admin.storageOverview(t); }

  @Get('push-overview') push(@AccessToken() t: string) { return this.admin.pushOverview(t); }

  /**
   * Stamps the caller's "last active" time, powering the activity column on the
   * admins page. A POST because it writes, and fire-and-forget by contract: the
   * console never blocks a render on it.
   */
  @Post('touch') touch(@AccessToken() t: string) { return this.admin.touch(t); }

  // ---- audit ----
  @Get('audit') audit(@AccessToken() t: string, @Query() q: AdminAuditQuery) {
    return this.admin.audit(t, q);
  }

  // ---- outbound notifications ----
  @Get('notifications') notifications(@AccessToken() t: string, @Query() q: AdminNotificationsQuery) {
    return this.admin.notifications(t, q);
  }

  /** Sends a notification to an explicit recipient list (capped by the RPC). */
  @Post('notifications/send') send(@AccessToken() t: string, @Body() dto: SendNotificationDto) {
    return this.admin.sendNotification(t, dto);
  }

  /** Broadcasts to an audience. The RPC enforces its own hourly rate limit. */
  @Post('notifications/announce') announce(@AccessToken() t: string, @Body() dto: AnnounceDto) {
    return this.admin.announce(t, dto);
  }
}

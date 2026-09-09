import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AdminService } from './admin.service';
import { AdminGuard } from './guards/admin.guard';
import { AccessToken } from '../common/decorators/current-user.decorator';
import { AppException } from '../common/errors/app-exception';
import { isUuid } from '../common/utils/uuid';
import {
  AdminSearchQuery,
  AdminUsersQuery,
  AdminVerificationQuery,
  DecideVerificationDto,
  DisableAdminDto,
  NoteDto,
  PermanentDeleteDto,
  RestrictDto,
  SetIdentityStatusDto,
  SetPremiumDto,
  SetRoleCapabilityDto,
  SetVerifiedDto,
  UpsertAdminDto,
  VerificationControlDto,
} from './dto/admin.dto';

function uuid(id: string, label = 'id'): void {
  if (!isUuid(id)) throw AppException.validation(`Invalid ${label}.`);
}

/**
 * `/api/v1/admin` — user/identity management, verification queue, and admin/role
 * administration. Static routes are declared before `:id` routes.
 */
@Controller('admin')
@UseGuards(AdminGuard)
export class AdminUsersController {
  constructor(private readonly admin: AdminService) {}

  /**
   * The signed-in admin's own identity and capability set (`admin_me`).
   *
   * Admin consoles need this to gate their UI before rendering. Exposing it as a
   * route means a console can authenticate and authorize entirely through this
   * API — Supabase Auth for the session, the backend for "is this caller an
   * admin and what may they do" — instead of holding a database client of its
   * own. AdminGuard already ran, so reaching the handler means the caller is an
   * admin; the payload tells the console which sections to show.
   */
  @Get('me') me(@AccessToken() t: string) { return this.admin.me(t); }

  // users
  @Get('users') users(@AccessToken() t: string, @Query() q: AdminUsersQuery) { return this.admin.users(t, q); }
  @Get('users/search') search(@AccessToken() t: string, @Query() q: AdminSearchQuery) {
    return this.admin.searchIdentities(t, q.q, q.kind, q.limit);
  }
  @Get('users/:id') detail(@AccessToken() t: string, @Param('id') id: string) {
    uuid(id, 'identity id');
    return this.admin.identityDetail(t, id);
  }
  @Post('users/:id/status') setStatus(@AccessToken() t: string, @Param('id') id: string, @Body() dto: SetIdentityStatusDto) {
    uuid(id, 'identity id');
    return this.admin.setIdentityStatus(t, id, dto.status, dto.reason);
  }
  @Post('users/:id/verified') setVerified(@AccessToken() t: string, @Param('id') id: string, @Body() dto: SetVerifiedDto) {
    uuid(id, 'identity id');
    return this.admin.setVerified(t, id, dto.verified, dto.reason);
  }
  @Post('users/:id/premium') setPremium(@AccessToken() t: string, @Param('id') id: string, @Body() dto: SetPremiumDto) {
    uuid(id, 'identity id');
    return this.admin.setPremium(t, id, dto.premium, dto.reason);
  }
  @Post('users/:id/restrict') restrict(@AccessToken() t: string, @Param('id') id: string, @Body() dto: RestrictDto) {
    uuid(id, 'identity id');
    return this.admin.restrict(t, id, dto.days, dto.reason);
  }

  /**
   * Permanently delete deactivated profiles (P6). The backend purges every R2
   * object and Stream asset the identities own, then the RPC removes the DB
   * rows and audits. Irreversible — the capability gate is `users.permanent_delete`.
   */
  @Post('users/permanent-delete') permanentDeleteUsers(
    @AccessToken() t: string,
    @Body() dto: PermanentDeleteDto,
  ) {
    return this.admin.permanentDeleteUsers(t, dto.ids);
  }

  // verification
  @Get('verification') queue(@AccessToken() t: string, @Query() q: AdminVerificationQuery) { return this.admin.verificationQueue(t, q); }
  @Get('verification/control') controlGet(@AccessToken() t: string) {
    return this.admin.verificationControlGet(t);
  }
  @Post('verification/control') controlSet(@AccessToken() t: string, @Body() dto: VerificationControlDto) {
    return this.admin.verificationControlSet(t, dto);
  }
  @Get('verification/:id') vDetail(@AccessToken() t: string, @Param('id') id: string) {
    uuid(id, 'request id');
    return this.admin.verificationDetail(t, id);
  }
  @Post('verification/:id/decide') decide(@AccessToken() t: string, @Param('id') id: string, @Body() dto: DecideVerificationDto) {
    uuid(id, 'request id');
    return this.admin.decideVerification(t, id, dto);
  }

  // admins & roles
  @Get('admins') admins(@AccessToken() t: string) { return this.admin.admins(t); }
  @Get('capabilities') caps(@AccessToken() t: string) { return this.admin.capabilityIds(t); }
  @Get('role-capabilities/:level') capsFor(@AccessToken() t: string, @Param('level') level: string) {
    return this.admin.capsForLevel(t, level);
  }
  @Post('admins') upsertAdmin(@AccessToken() t: string, @Body() dto: UpsertAdminDto) { return this.admin.upsertAdmin(t, dto); }
  @Post('admins/:id/revoke') revoke(@AccessToken() t: string, @Param('id') id: string, @Body() dto: NoteDto) {
    uuid(id, 'identity id');
    return this.admin.revokeAdmin(t, id, dto.note);
  }
  @Post('admins/:id/disable') disable(@AccessToken() t: string, @Param('id') id: string, @Body() dto: DisableAdminDto) {
    uuid(id, 'identity id');
    return this.admin.disableAdmin(t, id, dto);
  }
  @Post('role-capabilities') setCap(@AccessToken() t: string, @Body() dto: SetRoleCapabilityDto) {
    return this.admin.setRoleCapability(t, dto);
  }
}

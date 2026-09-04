import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { SecurityService } from './security.service';
import {
  BeginLoginDto,
  CodeDto,
  DecideLoginApprovalDto,
  EnabledDto,
  PasswordDto,
  SetRecoveryEmailDto,
  SetTwoStepDto,
} from './dto/security.dto';
import { AccessToken, CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/http/request-context';
import { AppException } from '../common/errors/app-exception';
import { isUuid } from '../common/utils/uuid';

class ActivityQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

/**
 * `/api/v1/security`. Account-level (personal) security. All routes require a
 * valid JWT; the RPCs behind them do their own reauth/permission checks.
 *
 * Routes that owe the user an email take `@CurrentUser()` as well as the token:
 * the user id from the verified JWT is what scopes the outbox drain, so a caller
 * can never dispatch another account's queued mail.
 */
@Controller('security')
export class SecurityController {
  constructor(private readonly security: SecurityService) {}

  @Get('overview')
  overview(@AccessToken() token: string) {
    return this.security.overview(token);
  }

  @Get('devices')
  devices(@AccessToken() token: string) {
    return this.security.devices(token);
  }

  @Get('activity')
  activity(@AccessToken() token: string, @Query() q: ActivityQueryDto) {
    return this.security.activity(token, q.limit);
  }

  @Get('login-status')
  loginStatus(@AccessToken() token: string) {
    return this.security.loginStatus(token);
  }

  @Get('session-alive')
  sessionAlive(@AccessToken() token: string) {
    return this.security.sessionAlive(token);
  }

  // ---- recovery email ----
  @Post('recovery-email')
  setRecoveryEmail(
    @AccessToken() token: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: SetRecoveryEmailDto,
  ) {
    return this.security.setRecoveryEmail(token, user.id, dto.email);
  }

  @Post('recovery-email/verify')
  verifyRecoveryEmail(@AccessToken() token: string, @Body() dto: CodeDto) {
    return this.security.verifyRecoveryEmail(token, dto.code);
  }

  @Post('recovery-email/resend')
  resendRecoveryOtp(@AccessToken() token: string, @CurrentUser() user: AuthenticatedUser) {
    return this.security.resendRecoveryOtp(token, user.id);
  }

  @Delete('recovery-email')
  removeRecoveryEmail(@AccessToken() token: string) {
    return this.security.removeRecoveryEmail(token);
  }

  // ---- two-step / alerts ----
  @Put('two-step/master')
  setTwoStepMaster(@AccessToken() token: string, @Body() dto: EnabledDto) {
    return this.security.setTwoStepMaster(token, dto.enabled);
  }

  @Put('two-step')
  setTwoStep(@AccessToken() token: string, @Body() dto: SetTwoStepDto) {
    return this.security.setTwoStep(token, dto.method, dto.enabled);
  }

  @Put('new-login-alerts')
  setNewLoginAlerts(@AccessToken() token: string, @Body() dto: EnabledDto) {
    return this.security.setNewLoginAlerts(token, dto.enabled);
  }

  @Post('mfa-log')
  logMfa(@AccessToken() token: string, @Body() dto: EnabledDto) {
    return this.security.logMfa(token, dto.enabled);
  }

  // ---- reauth ----
  @Post('reauth/password')
  reauthPassword(@AccessToken() token: string, @Body() dto: PasswordDto) {
    return this.security.reauthPassword(token, dto.password);
  }

  @Post('reauth/mfa-confirm')
  confirmMfaReauth(@AccessToken() token: string) {
    return this.security.confirmMfaReauth(token);
  }

  // ---- sessions ----
  @Post('sessions/revoke-others')
  revokeOthers(@AccessToken() token: string) {
    return this.security.revokeOthers(token);
  }

  @Post('sessions/:id/revoke')
  revokeSession(@AccessToken() token: string, @Param('id') id: string) {
    if (!isUuid(id)) throw AppException.validation('Invalid session id.');
    return this.security.revokeSession(token, id);
  }

  // ---- new-device login approval ----
  @Post('login/begin')
  beginLogin(
    @AccessToken() token: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: BeginLoginDto,
  ) {
    return this.security.beginLogin(token, user.id, dto);
  }

  @Post('login/approve-via-mfa')
  approveLoginViaMfa(@AccessToken() token: string) {
    return this.security.approveLoginViaMfa(token);
  }

  @Post('login/email-code/send')
  sendLoginEmailCode(@AccessToken() token: string, @CurrentUser() user: AuthenticatedUser) {
    return this.security.sendLoginEmailCode(token, user.id);
  }

  @Post('login/email-code/verify')
  verifyLoginEmailCode(@AccessToken() token: string, @Body() dto: CodeDto) {
    return this.security.verifyLoginEmailCode(token, dto.code);
  }

  @Get('login/:request/approval')
  loginApproval(@AccessToken() token: string, @Param('request') request: string) {
    if (!isUuid(request)) throw AppException.validation('Invalid request id.');
    return this.security.loginApproval(token, request);
  }

  @Post('login/:request/decide')
  decideLoginApproval(
    @AccessToken() token: string,
    @Param('request') request: string,
    @Body() dto: DecideLoginApprovalDto,
  ) {
    if (!isUuid(request)) throw AppException.validation('Invalid request id.');
    return this.security.decideLoginApproval(token, request, dto.approve);
  }
}

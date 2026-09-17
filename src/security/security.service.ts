import { HttpStatus, Injectable } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { EmailOutboxService, type OutboxFlushResult } from '../email/email-outbox.service';
import { AppException } from '../common/errors/app-exception';
import { ErrorCode } from '../common/errors/error-codes';
import { clampLimit } from '../common/dto/pagination.dto';
import type { BeginLoginDto } from './dto/security.dto';

type Json = Record<string, unknown>;

/**
 * Account-level security. Every method is a thin wrapper over a `security_*`
 * SECURITY DEFINER RPC that resolves the user from `auth.uid()` — so the backend
 * never handles passwords or verifies OTPs itself.
 *
 * Email ownership: the RPCs that owe the user a message enqueue it in
 * `public.email_outbox`; this service drains that queue through
 * {@link EmailOutboxService} before responding, so the API reports real delivery
 * instead of assuming it. No Supabase Edge Function is in the path.
 * Internal-only RPCs (send_email, gen_otp, log, ensure_settings) are
 * intentionally NOT exposed here.
 */
@Injectable()
export class SecurityService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly outbox: EmailOutboxService,
  ) {}

  /**
   * Sends whatever the RPC just queued and folds the outcome into the response.
   *
   * `required` marks the flows where the message IS the deliverable — a sign-in
   * code the user is sitting and waiting for. There, a delivery failure must be
   * an error: the alternative is telling them a code is on its way when it is
   * not. Side-channel mail (the new-device alert) is reported, never fatal.
   */
  private async withDelivery(
    userId: string,
    result: Json | null,
    opts: { required: boolean; failureMessage?: string },
  ): Promise<Json | null> {
    const flush: OutboxFlushResult = await this.outbox.flushForUser(userId);
    const delivery = EmailOutboxService.toDelivery(flush);

    if (opts.required && !delivery.emailDispatched) {
      throw new AppException(
        HttpStatus.BAD_GATEWAY,
        ErrorCode.EMAIL_DELIVERY_FAILED,
        opts.failureMessage ??
          'We could not send that email right now. Please try again in a moment.',
        { reason: delivery.reason },
      );
    }

    return result === null ? null : { ...result, delivery };
  }


  overview(token: string) {
    return this.supabase.rpcAsCaller<Json>(token, 'security_overview');
  }

  devices(token: string) {
    return this.supabase.rpcAsCaller<Json>(token, 'security_devices');
  }

  activity(token: string, limit?: number) {
    return this.supabase.rpcAsCaller<Json>(token, 'security_activity_feed', {
      p_limit: clampLimit(limit, 50, 100),
    });
  }

  loginStatus(token: string) {
    return this.supabase.rpcAsCaller<Json>(token, 'security_login_status');
  }

  sessionAlive(token: string) {
    return this.supabase.rpcAsCaller<boolean>(token, 'security_session_alive');
  }

  // ---- recovery email ----
  /** Queues a `recovery_otp` mail; the code is worthless if it never arrives. */
  async setRecoveryEmail(token: string, userId: string, email: string) {
    const res = await this.supabase.rpcAsCaller<Json>(token, 'security_set_recovery_email', { p_email: email });
    return this.withDelivery(userId, res, {
      required: true,
      failureMessage: 'We could not send the code to that address. Please try again in a moment.',
    });
  }
  verifyRecoveryEmail(token: string, code: string) {
    return this.supabase.rpcAsCaller<Json>(token, 'security_verify_recovery_email', { p_code: code });
  }
  async resendRecoveryOtp(token: string, userId: string) {
    const res = await this.supabase.rpcAsCaller<Json>(token, 'security_resend_recovery_email_otp');
    return this.withDelivery(userId, res, {
      required: true,
      failureMessage: 'We could not resend the code. Please try again in a moment.',
    });
  }
  async removeRecoveryEmail(token: string, userId: string) {
    const res = await this.supabase.rpcAsCaller<Json>(token, 'security_remove_recovery_email');
    // The RPC queued a security_alert mail; drain it in the same request.
    return this.withDelivery(userId, res, { required: false });
  }

  // ---- two-step / alerts ----
  // Every one of these writes a security_alert notification, whose email copy
  // rides the outbox (see security_notify). Draining here delivers it in the
  // same request, reported in `delivery`, never fatal.
  async setTwoStepMaster(token: string, userId: string, enabled: boolean) {
    const res = await this.supabase.rpcAsCaller<Json>(token, 'security_set_two_step_master', { p_enabled: enabled });
    return this.withDelivery(userId, res, { required: false });
  }
  async setTwoStep(token: string, userId: string, method: string, enabled: boolean) {
    const res = await this.supabase.rpcAsCaller<Json>(token, 'security_set_two_step', { p_method: method, p_enabled: enabled });
    return this.withDelivery(userId, res, { required: false });
  }
  setNewLoginAlerts(token: string, enabled: boolean) {
    return this.supabase.rpcAsCaller<Json>(token, 'security_set_new_login_alerts', { p_enabled: enabled });
  }
  async logMfa(token: string, userId: string, enabled: boolean) {
    const res = await this.supabase.rpcAsCaller<Json>(token, 'security_log_mfa', { p_enabled: enabled });
    return this.withDelivery(userId, res, { required: false });
  }

  // ---- reauth ----
  reauthPassword(token: string, password: string) {
    return this.supabase.rpcAsCaller<Json>(token, 'security_reauth_password', { p_password: password });
  }
  confirmMfaReauth(token: string) {
    return this.supabase.rpcAsCaller<Json>(token, 'security_confirm_mfa_reauth');
  }

  // ---- sessions ----
  async revokeSession(token: string, userId: string, sessionId: string) {
    const res = await this.supabase.rpcAsCaller<Json>(token, 'security_revoke_session', { p_session_id: sessionId });
    // Revoking a single device writes a security alert when the RPC considers
    // it notable; drain whatever landed.
    return this.withDelivery(userId, res, { required: false });
  }
  async revokeOthers(token: string, userId: string) {
    const res = await this.supabase.rpcAsCaller<Json>(token, 'security_revoke_others');
    return this.withDelivery(userId, res, { required: false });
  }

  // ---- new-device login approval ----
  /**
   * May queue a `new_device` alert. That alert is a courtesy, not the gate — a
   * delivery fault is reported in `delivery` but must never block the sign-in.
   */
  async beginLogin(token: string, userId: string, dto: BeginLoginDto) {
    const res = await this.supabase.rpcAsCaller<Json>(token, 'security_begin_login', {
      p_device_id: dto.device_id,
      p_device_name: dto.device_name,
      p_platform: dto.platform,
      p_app_version: dto.app_version,
    });
    return this.withDelivery(userId, res, { required: false });
  }
  loginApproval(token: string, request: string) {
    return this.supabase.rpcAsCaller<Json>(token, 'security_login_approval', { p_request: request });
  }
  decideLoginApproval(token: string, request: string, approve: boolean) {
    return this.supabase.rpcAsCaller<Json>(token, 'security_decide_login_approval', {
      p_request: request,
      p_approve: approve,
    });
  }
  approveLoginViaMfa(token: string) {
    return this.supabase.rpcAsCaller<Json>(token, 'security_approve_login_via_mfa');
  }
  /**
   * The sign-in code IS the deliverable — the user is blocked on this device
   * until it arrives, so a delivery failure is an error, not a 200.
   * `already: true` means the session was verified before this call and no mail
   * was owed; the empty flush reports dispatched and nothing is claimed.
   */
  async sendLoginEmailCode(token: string, userId: string) {
    const res = await this.supabase.rpcAsCaller<Json>(token, 'security_send_login_email_code');
    return this.withDelivery(userId, res, {
      required: true,
      failureMessage: 'We could not send your sign-in code. Please try again in a moment.',
    });
  }
  verifyLoginEmailCode(token: string, code: string) {
    return this.supabase.rpcAsCaller<Json>(token, 'security_verify_login_email_code', { p_code: code });
  }
}

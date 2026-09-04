import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { EmailService } from '../email/email.service';

/**
 * Signed-out account recovery via a VERIFIED recovery email. `start` mints a
 * hashed OTP in Postgres and mails the plaintext through {@link EmailService};
 * `verify` checks it and returns a real gotrue recovery `token_hash` via the Auth
 * admin API. No Edge Function is involved.
 *
 * Responses are deliberately generic so the endpoint cannot probe which emails
 * exist — which means a delivery failure CANNOT be reported to the caller here
 * without leaking account existence. It is logged instead, with the address
 * masked; operators diagnose it through `POST
 * /api/v1/webhooks/internal/email-diagnostics`.
 */
@Injectable()
export class AccountRecoveryService {
  private readonly log = new Logger(AccountRecoveryService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly email: EmailService,
  ) {}

  async start(email: string): Promise<{ ok: true }> {
    try {
      const data = await this.supabase.rpcAsService<{
        found?: boolean;
        code?: string;
        recovery_email?: string;
        rate_limited?: boolean;
      }>('account_recovery_start', { p_email: email });

      if (data?.found === true && data.code && data.recovery_email) {
        const result = await this.email.sendRecoveryOtp(
          String(data.recovery_email),
          String(data.code),
        );
        if (!result.sent) {
          // Never surfaced to the caller (enumeration); never carries the code.
          this.log.warn(
            `account recovery mail not delivered kind=${result.failureKind ?? 'unknown'} ` +
              `code=${result.providerCode ?? '-'} reason=${result.skipped ?? result.error ?? '-'}`,
          );
        }
      }
    } catch (e) {
      this.log.warn(
        `account_recovery_start failed: ${e instanceof Error ? e.message : 'unknown error'}`,
      );
    }
    return { ok: true };
  }

  async verify(email: string, code: string): Promise<{ ok: boolean; token_hash?: string }> {
    try {
      const data = await this.supabase.rpcAsService<{ ok?: boolean; primary_email?: string }>(
        'account_recovery_verify',
        { p_email: email, p_code: code },
      );
      if (!data || data.ok !== true || !data.primary_email) return { ok: false };

      const { data: link, error } = await this.supabase.service().auth.admin.generateLink({
        type: 'recovery',
        email: String(data.primary_email),
      });
      const tokenHash = link?.properties?.hashed_token;
      if (error || !tokenHash) return { ok: false };
      return { ok: true, token_hash: tokenHash };
    } catch {
      return { ok: false };
    }
  }
}

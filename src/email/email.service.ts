import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import { AppConfigService } from '../config/app-config.service';

const LOGO =
  'https://gaorqbmwvjlealpxvswt.supabase.co/storage/v1/object/public/avatars/esporta_text_logo.png';
const GREEN = '#39FF14';
const BG = '#0B0F0D';
const CARD = '#121816';
const TEXT = '#F2F5F3';
const MUTED = '#8E9B94';
const BORDER = 'rgba(255,255,255,0.08)';
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

const SECURITY_FOOTER =
  'You are receiving this because a security action was requested on your Esporta account. ' +
  'If this was not you, sign in and review your logged-in devices right away.';

/** Every template the backend can render. Outbox rows carry one of these names. */
export type EmailTemplateName =
  | 'recovery_otp'
  | 'login_code'
  | 'new_device'
  | 'account_recovery_otp';

export interface Composed {
  subject: string;
  html: string;
  text: string;
}

/**
 * The outcome of one send attempt. `sent` is true ONLY when the SMTP server
 * accepted the message — never as a default, and never when SMTP is unconfigured.
 */
export interface SendResult {
  sent: boolean;
  /** Set when nothing was attempted, e.g. `smtp_not_configured`. */
  skipped?: string;
  /** Sanitised failure reason, safe to log and to return to an operator. */
  error?: string;
  /** SMTP reply code when the provider rejected the message (e.g. 535). */
  providerCode?: number;
  /** Short nodemailer error class, e.g. `EAUTH`, `ECONNECTION`, `ETIMEDOUT`. */
  failureKind?: string;
}

export interface SmtpConfigSummary {
  configured: boolean;
  host?: string;
  port: number;
  encryption: 'implicit_tls' | 'starttls' | 'plaintext';
  usernamePresent: boolean;
  passwordPresent: boolean;
  passwordLength: number;
  fromPresent: boolean;
  usernameMasked?: string;
  fromMasked?: string;
  missing: string[];
}

function escapeHtml(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** `alice@example.com` -> `a***@example.com`. Never returns the local part. */
function maskEmail(v: string | undefined): string | undefined {
  const s = (v ?? '').trim();
  if (!s) return undefined;
  const at = s.indexOf('@');
  return at < 1 ? '***' : `${s[0]}***${s.slice(at)}`;
}

/**
 * Strips anything credential-shaped out of a provider reply before it is logged
 * or returned. Long base64-ish runs are what an AUTH exchange looks like.
 */
function sanitize(v: unknown, max = 300): string {
  return String(v ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/(AUTH\s+\w+\s+)\S+/gi, '$1<redacted>')
    .replace(/[A-Za-z0-9+/]{24,}={0,2}/g, '<redacted>')
    .trim()
    .slice(0, max);
}

function shell(inner: string, footer: string, preheader: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark"></head>
<body style="margin:0;padding:0;background:${BG};">
<span style="display:none!important;opacity:0;color:transparent;height:0;width:0;overflow:hidden;">${escapeHtml(preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BG};margin:0;padding:0;">
  <tr><td align="center" style="padding:36px 16px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;width:100%;">
      <tr><td align="center" style="padding-bottom:26px;">
        <img src="${LOGO}" alt="Esporta" width="156" style="display:block;width:156px;max-width:62%;height:auto;border:0;">
      </td></tr>
      <tr><td style="background:${CARD};border:1px solid ${BORDER};border-radius:18px;padding:34px 30px;font-family:${FONT};color:${TEXT};">${inner}</td></tr>
      <tr><td style="padding:22px 10px 0;font-family:${FONT};color:${MUTED};font-size:12px;line-height:1.7;">${footer}</td></tr>
      <tr><td align="center" style="padding:18px 10px 0;font-family:${FONT};color:${MUTED};font-size:11px;line-height:1.6;opacity:0.8;">&copy; Esporta &middot; The esports marketplace</td></tr>
    </table>
  </td></tr>
</table></body></html>`;
}

function codeBlock(code: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 6px;">
  <tr><td align="center" style="background:rgba(57,255,20,0.09);border:1px solid rgba(57,255,20,0.30);border-radius:14px;padding:20px 12px;">
    <span style="font-size:34px;font-weight:700;letter-spacing:12px;color:${GREEN};font-family:'SFMono-Regular',Consolas,Menlo,monospace;">${code}</span>
  </td></tr></table>`;
}

const heading = (t: string) => `<div style="font-size:20px;font-weight:700;line-height:1.3;margin:0 0 10px;color:${TEXT};">${t}</div>`;
const paragraph = (t: string) => `<div style="color:${MUTED};font-size:15px;line-height:1.65;margin:0 0 18px;">${t}</div>`;
const expires = (m: number) => `<div style="color:${MUTED};font-size:13px;text-align:center;margin-top:14px;">This code expires in ${m} minutes. Never share it with anyone.</div>`;

/**
 * The single delivery service for every NestJS-owned Esporta email — login 2FA
 * codes, new-sign-in alerts, recovery OTPs, and future transactional mail.
 * Supabase Auth still sends its own signup / password-reset mail through the
 * project's Custom SMTP; no Edge Function is involved in either path.
 *
 * Honesty contract: {@link sendTemplate} reports `sent: true` only when the SMTP
 * server accepted the message. An unconfigured transport reports
 * `skipped: 'smtp_not_configured'`, and a rejection reports the sanitised
 * provider reply. It never defaults to success.
 *
 * Nothing here logs a password, an OTP, or a token: codes are rendered into the
 * message body and never passed to the logger, and provider replies go through
 * {@link sanitize}.
 */
@Injectable()
export class EmailService {
  private readonly log = new Logger(EmailService.name);
  private transporter: Transporter | null = null;

  constructor(private readonly config: AppConfigService) {}

  get configured(): boolean {
    return this.config.smtp.configured && !!this.from;
  }

  private get from(): string {
    return this.config.smtp.fromEmail ?? this.config.smtp.username ?? '';
  }

  /** Config shape for diagnostics. Reports presence and length — never values. */
  configSummary(): SmtpConfigSummary {
    const s = this.config.smtp;
    const from = this.from;
    const missing = [
      !s.host && 'SMTP_HOST',
      !s.username && 'SMTP_USERNAME',
      !s.password && 'SMTP_PASSWORD',
      !from && 'SMTP_FROM_EMAIL',
    ].filter(Boolean) as string[];

    return {
      configured: this.configured,
      host: s.host,
      port: s.port,
      encryption: s.port === 465 ? 'implicit_tls' : s.port === 587 ? 'starttls' : 'plaintext',
      usernamePresent: !!s.username,
      passwordPresent: !!s.password,
      passwordLength: s.password?.length ?? 0,
      fromPresent: !!from,
      usernameMasked: maskEmail(s.username),
      fromMasked: maskEmail(from),
      missing,
    };
  }

  private transport(): Transporter | null {
    if (!this.configured) return null;
    if (!this.transporter) {
      const s = this.config.smtp;
      const implicitTls = s.port === 465;
      const options: SMTPTransport.Options = {
        host: s.host,
        port: s.port,
        // 465 is implicit TLS; 587 must negotiate STARTTLS and must not fall
        // back to plaintext if the server declines it.
        secure: implicitTls,
        requireTLS: !implicitTls,
        auth: { user: s.username, pass: s.password },
        connectionTimeout: 15_000,
        greetingTimeout: 15_000,
        socketTimeout: 20_000,
      };
      this.transporter = nodemailer.createTransport(options);
    }
    return this.transporter;
  }

  /**
   * Opens a connection and authenticates WITHOUT sending a message — the safe
   * SMTP probe. Distinguishes "credentials rejected" from "cannot connect",
   * which is the difference between a revoked app password and a network fault.
   */
  async verifyTransport(): Promise<SendResult> {
    const transport = this.transport();
    if (!transport) {
      return { sent: false, skipped: 'smtp_not_configured', error: this.configSummary().missing.join(', ') };
    }
    try {
      await transport.verify();
      return { sent: true };
    } catch (e) {
      return { sent: false, ...this.describeFailure(e) };
    }
  }

  /** Renders and sends one template. Never throws; the result carries the truth. */
  async sendTemplate(
    to: string,
    template: string,
    vars: Record<string, unknown> = {},
  ): Promise<SendResult> {
    const composed = this.compose(template, vars);
    if (!composed) {
      return { sent: false, error: `unknown_template:${sanitize(template, 40)}`, failureKind: 'ETEMPLATE' };
    }
    return this.send(to, composed);
  }

  /** @deprecated Use {@link sendTemplate}. Kept for the existing security callers. */
  sendSecurity(to: string, template: string, vars: Record<string, unknown>): Promise<SendResult> {
    return this.sendTemplate(to, template, vars);
  }

  sendRecoveryOtp(to: string, code: string): Promise<SendResult> {
    return this.sendTemplate(to, 'account_recovery_otp', { code });
  }

  /**
   * End-to-end delivery probe. Deliberately not a template: it carries no code,
   * no link and no account detail, so it is safe to send from an ops endpoint.
   */
  sendDiagnostic(to: string): Promise<SendResult> {
    return this.send(to, {
      subject: 'Esporta SMTP delivery test',
      text:
        'This is an Esporta SMTP delivery test. It carries no code and no link.\n' +
        'If you received it, the Esporta backend can deliver mail.',
      html: shell(
        heading('SMTP delivery test') +
          paragraph(
            'This message carries no code and no link. If it reached you, the Esporta ' +
              'backend can deliver mail through the configured SMTP provider.',
          ),
        'Sent by an operator from the Esporta backend email diagnostic.',
        'Esporta SMTP delivery test',
      ),
    });
  }

  private async send(to: string, c: Composed): Promise<SendResult> {
    const transport = this.transport();
    if (!transport) {
      return { sent: false, skipped: 'smtp_not_configured', error: this.configSummary().missing.join(', ') };
    }
    const recipient = (to ?? '').trim();
    if (!recipient) return { sent: false, error: 'missing_recipient', failureKind: 'ERECIPIENT' };

    try {
      const info = await transport.sendMail({
        from: `Esporta Security <${this.from}>`,
        to: recipient,
        subject: c.subject,
        text: c.text,
        html: c.html,
      });
      // A message the server neither accepted nor rejected is not a success.
      const accepted = Array.isArray(info?.accepted) ? info.accepted.length : 0;
      if (accepted === 0) {
        return {
          sent: false,
          error: sanitize(info?.response ?? 'no recipient accepted'),
          failureKind: 'ENOTACCEPTED',
        };
      }
      return { sent: true };
    } catch (e) {
      const failure = this.describeFailure(e);
      // Recipient is masked; the code lives only in the message body.
      this.log.warn(
        `email send failed to=${maskEmail(recipient)} kind=${failure.failureKind ?? 'unknown'} ` +
          `code=${failure.providerCode ?? '-'} detail=${failure.error ?? '-'}`,
      );
      return { sent: false, ...failure };
    }
  }

  /** Turns a nodemailer/SMTP error into safe, actionable metadata. */
  private describeFailure(e: unknown): Omit<SendResult, 'sent'> {
    const err = (e ?? {}) as {
      code?: string;
      responseCode?: number;
      response?: string;
      command?: string;
      message?: string;
    };
    const providerReply = err.response ? sanitize(err.response) : undefined;
    const detail = providerReply ?? sanitize(err.message ?? String(e));
    return {
      error: err.command ? `${detail} (command=${sanitize(err.command, 20)})` : detail,
      providerCode: typeof err.responseCode === 'number' ? err.responseCode : undefined,
      failureKind: err.code ? sanitize(err.code, 24) : undefined,
    };
  }

  private compose(template: string, vars: Record<string, unknown>): Composed | null {
    switch (template as EmailTemplateName) {
      case 'recovery_otp': {
        const code = String(vars.code ?? '').replace(/[^0-9]/g, '');
        return {
          subject: 'Your Esporta recovery code',
          text: `Your Esporta recovery code is ${code}. It expires in 10 minutes. Never share it.`,
          html: shell(
            heading('Verify your recovery email') +
              paragraph('Enter this code in the app to confirm this address as a recovery email for your account.') +
              codeBlock(code) + expires(10),
            SECURITY_FOOTER,
            `Your recovery code is ${code}`,
          ),
        };
      }
      case 'login_code': {
        const code = String(vars.code ?? '').replace(/[^0-9]/g, '');
        return {
          subject: 'Your Esporta sign-in code',
          text: `Your Esporta sign-in verification code is ${code}. It expires in 10 minutes. Never share it.`,
          html: shell(
            heading('Confirm it\u2019s you') +
              paragraph('Use this code in the app to finish signing in on your new device.') +
              codeBlock(code) + expires(10),
            'If you are not trying to sign in, someone may have your password. Change it and review your logged-in devices right away.',
            `Your sign-in code is ${code}`,
          ),
        };
      }
      case 'account_recovery_otp': {
        const code = String(vars.code ?? '').replace(/[^0-9]/g, '');
        return {
          subject: 'Recover your Esporta account',
          text: `Your Esporta account recovery code is ${code}. It expires in 10 minutes. If you did not request this, ignore this email.`,
          html: shell(
            heading('Recover your account') +
              paragraph('Enter this code in the app to recover access to your Esporta account.') +
              codeBlock(code) + expires(10),
            'If you did not request account recovery, ignore this email &mdash; your account is unchanged.',
            `Your account recovery code is ${code}`,
          ),
        };
      }
      case 'new_device': {
        const device = escapeHtml(String(vars.device ?? 'A new device'));
        const platform = escapeHtml(String(vars.platform ?? ''));
        const ip = escapeHtml(String(vars.ip ?? ''));
        const when = escapeHtml(String(vars.when ?? ''));
        const line = platform ? `${device} &middot; ${platform}` : device;
        const rows = [
          `<div style="font-size:15px;font-weight:600;color:${TEXT};">${line}</div>`,
          ip ? `<div style="color:${MUTED};font-size:13px;margin-top:4px;">IP address: ${ip}</div>` : '',
          when ? `<div style="color:${MUTED};font-size:13px;margin-top:2px;">${when}</div>` : '',
        ].join('');
        return {
          subject: 'New sign-in to your Esporta account',
          text: `A new sign-in was detected on your Esporta account: ${platform ? `${device} (${platform})` : device}. If this was not you, open Security and log out that device, then change your password.`,
          html: shell(
            heading('New sign-in detected') +
              paragraph('A device just signed in to your Esporta account:') +
              `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:rgba(57,255,20,0.07);border:1px solid rgba(57,255,20,0.22);border-radius:12px;padding:16px 18px;">${rows}</td></tr></table>` +
              `<div style="color:${MUTED};font-size:14px;line-height:1.65;margin-top:18px;">If this was you, no action is needed. If not, open <b style="color:${TEXT};">Security &rarr; Logged-in devices</b>, log it out, and change your password.</div>`,
            SECURITY_FOOTER,
            `New sign-in: ${device}`,
          ),
        };
      }
      default:
        return null;
    }
  }
}

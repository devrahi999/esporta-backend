import { Injectable } from '@nestjs/common';
import { createSign } from 'node:crypto';
import { AppConfigService } from '../../config/app-config.service';

export interface SendResult {
  ok: boolean;
  unregistered: boolean;
  error?: string;
}

function b64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Firebase Cloud Messaging v1 sender (plan §22). Mints a Google service-account
 * OAuth token from the Firebase service-account key (RS256 JWT → token endpoint),
 * cached until shortly before expiry, then sends per-token messages. Reports
 * `configured=false` until the Firebase secrets are set.
 *
 * This is the only push sender in the product. There is no Edge Function.
 */
@Injectable()
export class FcmProvider {
  private cachedToken: { token: string; exp: number } | null = null;

  constructor(private readonly config: AppConfigService) {}

  get configured(): boolean {
    return this.config.firebase.configured;
  }

  get projectId(): string | undefined {
    return this.config.firebase.projectId;
  }

  private async accessToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (this.cachedToken && this.cachedToken.exp - 60 > now) return this.cachedToken.token;

    const { clientEmail, privateKey } = this.config.firebase;
    if (!clientEmail || !privateKey) {
      throw new Error('FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY are not set');
    }

    const header = { alg: 'RS256', typ: 'JWT' };
    const claim = {
      iss: clientEmail,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    };
    const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claim))}`;
    const signature = createSign('RSA-SHA256').update(unsigned).sign(privateKey);
    const jwt = `${unsigned}.${b64url(signature)}`;

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
      }),
    });
    const data = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
    if (!res.ok || !data.access_token) {
      throw new Error(`FCM token exchange failed: ${res.status}`);
    }
    this.cachedToken = { token: data.access_token, exp: now + Number(data.expires_in ?? 3600) };
    return this.cachedToken.token;
  }

  /** Pre-mints the token so a dispatch batch reuses one credential. */
  prepare(): Promise<string> {
    return this.accessToken();
  }

  async sendOne(
    accessToken: string,
    deviceToken: string,
    title: string,
    body: string,
    data: Record<string, string>,
    imageUrl?: string | null,
  ): Promise<SendResult> {
    const notification: Record<string, unknown> = body ? { title, body } : { title };
    // The acting profile's avatar. FCM v1 has no URL-based *large icon* — the
    // only URL image field is `notification.image`, which Android renders as
    // BigPictureStyle and iOS as an attachment. So the actor's picture rides
    // there; the small icon stays the Esporta mark from the manifest, which is
    // also what a system notification (no actor) is left showing on its own.
    if (imageUrl) notification.image = imageUrl;

    const message: Record<string, unknown> = {
      token: deviceToken,
      notification,
      data,
      android: { priority: 'HIGH', notification: { channel_id: 'esporta_default' } },
    };

    const res = await fetch(`https://fcm.googleapis.com/v1/projects/${this.projectId}/messages:send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });

    if (res.ok) return { ok: true, unregistered: false };

    const err = (await res.json().catch(() => ({}))) as {
      error?: { status?: string; details?: Array<{ errorCode?: string }> };
    };
    const status = err.error?.status ?? '';
    const code = err.error?.details?.[0]?.errorCode ?? '';
    const blob = JSON.stringify(err.error ?? err);
    const unregistered =
      res.status === 404 ||
      status === 'NOT_FOUND' ||
      status === 'UNREGISTERED' ||
      code === 'UNREGISTERED' ||
      (res.status === 400 && status === 'INVALID_ARGUMENT' && /registration token|not a valid fcm/i.test(blob));

    return { ok: false, unregistered, error: blob.slice(0, 500) };
  }
}

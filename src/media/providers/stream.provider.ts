import { Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppConfigService } from '../../config/app-config.service';
import { AppException } from '../../common/errors/app-exception';

const CF_API = 'https://api.cloudflare.com/client/v4';
const DELIVERY = 'https://videodelivery.net';

export interface DirectUpload {
  uploadUrl: string;
  uid: string;
}

/**
 * Cloudflare Stream access (plan §13–16). The backend requests a one-time
 * direct-creator upload URL (client uploads bytes straight to Stream — the
 * backend never runs FFmpeg, per §41), and Stream calls back via a signed
 * webhook when transcoding finishes. The video UID is the canonical reference;
 * playback URLs are derived from it.
 *
 * Reports `configured=false` (→ 503) until the Stream secrets are set.
 */
@Injectable()
export class StreamProvider {
  private readonly accountId?: string;
  private readonly apiToken?: string;
  private readonly webhookSecret?: string;
  readonly configured: boolean;

  constructor(config: AppConfigService) {
    const s = config.stream;
    this.configured = s.configured;
    this.accountId = s.accountId;
    this.apiToken = s.apiToken;
    this.webhookSecret = s.webhookSecret;
  }

  hlsUrl(uid: string): string {
    return `${DELIVERY}/${uid}/manifest/video.m3u8`;
  }

  thumbnailUrl(uid: string): string {
    return `${DELIVERY}/${uid}/thumbnails/thumbnail.jpg`;
  }

  private ensure(): void {
    if (!this.configured || !this.accountId || !this.apiToken) {
      throw AppException.unavailable('Video storage (Cloudflare Stream) is not configured.');
    }
  }

  /** Requests a one-time direct-creator upload URL + reserves the video UID. */
  async createDirectUpload(maxDurationSeconds: number, meta?: Record<string, string>): Promise<DirectUpload> {
    this.ensure();
    const res = await fetch(`${CF_API}/accounts/${this.accountId}/stream/direct_upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxDurationSeconds, requireSignedURLs: false, ...(meta ? { meta } : {}) }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      result?: { uploadURL?: string; uid?: string };
      errors?: unknown;
    };
    if (!res.ok || !body.result?.uploadURL || !body.result?.uid) {
      const errs = Array.isArray(body.errors) ? JSON.stringify(body.errors) : 'unknown error';
      throw AppException.upstream(
        `Cloudflare Stream direct upload failed (${res.status}). Body errors: ${errs}`,
        body.errors,
      );
    }
    return { uploadUrl: body.result.uploadURL, uid: body.result.uid };
  }

  async deleteVideo(uid: string): Promise<void> {
    this.ensure();
    const res = await fetch(`${CF_API}/accounts/${this.accountId}/stream/${uid}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${this.apiToken}` },
    });
    if (!res.ok && res.status !== 404) {
      throw AppException.upstream(`Cloudflare Stream delete failed (${res.status}).`);
    }
  }

  /**
   * Verifies a Stream webhook. Header form: `time=<ts>,sig1=<hex>`; the signed
   * payload is `<ts>.<rawBody>`, HMAC-SHA256 with the webhook secret. Constant-time
   * compare. Returns false (reject) when the secret or header is absent.
   */
  verifyWebhook(rawBody: string, signatureHeader: string | undefined): boolean {
    if (!this.webhookSecret || !signatureHeader) return false;
    const parts: Record<string, string> = {};
    for (const kv of signatureHeader.split(',')) {
      const idx = kv.indexOf('=');
      if (idx > 0) parts[kv.slice(0, idx).trim()] = kv.slice(idx + 1).trim();
    }
    const time = parts.time;
    const sig1 = parts.sig1;
    if (!time || !sig1) return false;
    const expected = createHmac('sha256', this.webhookSecret).update(`${time}.${rawBody}`).digest('hex');
    try {
      const a = Buffer.from(expected, 'hex');
      const b = Buffer.from(sig1, 'hex');
      return a.length === b.length && timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }
}

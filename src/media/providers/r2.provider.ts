import { Injectable } from '@nestjs/common';
import { AwsClient } from 'aws4fetch';
import { AppConfigService } from '../../config/app-config.service';
import { AppException } from '../../common/errors/app-exception';

export interface HeadResult {
  exists: boolean;
  contentType?: string;
  contentLength?: number;
}

/**
 * Cloudflare R2 access over the S3 API (plan §11). The backend never proxies
 * image bytes: it hands the client a short-lived presigned PUT URL and later
 * verifies the object with a HEAD. Server-side deletes use signed requests.
 *
 * When R2 secrets are absent the provider reports `configured=false` and every
 * operation raises 503, so the backend runs before credentials are wired.
 */
@Injectable()
export class R2Provider {
  private readonly client: AwsClient | null;
  private readonly bucket: string;
  private readonly endpoint: string;
  private readonly publicBase: string;
  readonly configured: boolean;

  constructor(config: AppConfigService) {
    const r2 = config.r2;
    this.configured = r2.configured;
    this.bucket = r2.bucket ?? 'esporta';
    this.endpoint = (r2.endpoint ?? '').replace(/\/+$/, '');
    this.publicBase = (r2.publicBaseUrl ?? '').replace(/\/+$/, '');
    this.client = this.configured
      ? new AwsClient({
          accessKeyId: r2.accessKeyId as string,
          secretAccessKey: r2.secretAccessKey as string,
          service: 's3',
          region: 'auto',
        })
      : null;
  }

  storagePath(key: string): string {
    return `${this.bucket}/${key}`;
  }

  publicUrl(key: string): string {
    return `${this.publicBase}/${key}`;
  }

  private objectUrl(key: string): string {
    return `${this.endpoint}/${this.bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }

  private ensure(): AwsClient {
    if (!this.client) throw AppException.unavailable('Image storage (R2) is not configured.');
    return this.client;
  }

  /** A short-lived presigned PUT URL the client uploads the bytes to directly. */
  async presignPut(key: string, expiresSeconds = 300): Promise<{ url: string; expiresSeconds: number }> {
    const client = this.ensure();
    // Content-Type is intentionally not signed, so the client may send its own;
    // the type/size are re-validated by head() at the complete step. Expiry is
    // set via the standard X-Amz-Expires query param.
    const url = new URL(this.objectUrl(key));
    url.searchParams.set('X-Amz-Expires', String(expiresSeconds));
    const signed = await client.sign(url.toString(), {
      method: 'PUT',
      aws: { signQuery: true },
    });
    return { url: signed.url, expiresSeconds };
  }

  /** Confirms an uploaded object exists and returns its type/size. */
  async head(key: string): Promise<HeadResult> {
    const client = this.ensure();
    const res = await client.fetch(this.objectUrl(key), { method: 'HEAD' });
    if (res.status === 404) return { exists: false };
    if (!res.ok) throw AppException.upstream(`R2 HEAD failed (${res.status}).`);
    const len = res.headers.get('content-length');
    return {
      exists: true,
      contentType: res.headers.get('content-type') ?? undefined,
      contentLength: len ? Number(len) : undefined,
    };
  }

  /** Deletes an object. A missing object is treated as success. */
  async delete(key: string): Promise<void> {
    const client = this.ensure();
    const res = await client.fetch(this.objectUrl(key), { method: 'DELETE' });
    if (!res.ok && res.status !== 404) {
      throw AppException.upstream(`R2 DELETE failed (${res.status}).`);
    }
  }
}

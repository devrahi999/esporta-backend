import {
  Controller,
  Post,
  RawBodyRequest,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { StreamProvider } from '../media/providers/stream.provider';
import { MediaService } from '../media/media.service';
import { Public } from '../common/decorators/public.decorator';
import { AppException } from '../common/errors/app-exception';
import { ErrorCode } from '../common/errors/error-codes';

/**
 * Provider webhooks. Public (no JWT) but each is gated by its own signature
 * (plan §35). The Cloudflare Stream callback advances a video's media row from
 * processing → ready/failed once transcoding completes.
 */
@Public()
@Controller('webhooks/cloudflare')
export class WebhooksController {
  constructor(
    private readonly stream: StreamProvider,
    private readonly media: MediaService,
  ) {}

  @Post('stream')
  async streamWebhook(@Req() req: RawBodyRequest<Request>) {
    const raw = req.rawBody instanceof Buffer ? req.rawBody.toString('utf8') : JSON.stringify(req.body ?? {});
    const signature = req.headers['webhook-signature'];
    const header = Array.isArray(signature) ? signature[0] : signature;

    if (!this.stream.verifyWebhook(raw, header)) {
      throw AppException.unauthenticated('Invalid webhook signature.', ErrorCode.INVALID_TOKEN);
    }

    const payload = (req.body ?? {}) as Record<string, unknown>;
    await this.media.applyStreamWebhook(payload);
    return { ok: true };
  }
}

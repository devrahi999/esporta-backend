import { Module } from '@nestjs/common';
import { WebhooksController } from './webhooks.controller';
import { MediaModule } from '../media/media.module';

@Module({
  imports: [MediaModule],
  controllers: [WebhooksController],
})
export class WebhooksModule {}

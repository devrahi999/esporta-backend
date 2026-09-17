import { Module } from '@nestjs/common';
import { PushController } from './push.controller';
import { PushService } from './push.service';
import { PushDispatchService } from './push-dispatch.service';
import { FcmProvider } from './providers/fcm.provider';

@Module({
  controllers: [PushController],
  providers: [PushService, PushDispatchService, FcmProvider],
  exports: [PushService, PushDispatchService, FcmProvider],
})
export class PushModule {}

import { Module } from '@nestjs/common';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';
import { R2Provider } from './providers/r2.provider';
import { StreamProvider } from './providers/stream.provider';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [MediaController],
  providers: [MediaService, R2Provider, StreamProvider],
  exports: [MediaService, R2Provider, StreamProvider],
})
export class MediaModule {}

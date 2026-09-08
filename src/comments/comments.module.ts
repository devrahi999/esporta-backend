import { Module } from '@nestjs/common';
import { CommentsController } from './comments.controller';
import { CommentsService } from './comments.service';
import { AuthModule } from '../auth/auth.module';
import { PlatformModule } from '../platform/platform.module';

@Module({
  imports: [AuthModule, PlatformModule],
  controllers: [CommentsController],
  providers: [CommentsService],
  exports: [CommentsService],
})
export class CommentsModule {}

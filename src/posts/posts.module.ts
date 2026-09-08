import { Module } from '@nestjs/common';
import { PostsController } from './posts.controller';
import { PostsService } from './posts.service';
import { AuthModule } from '../auth/auth.module';
import { RecommendationModule } from '../recommendation/recommendation.module';
import { PlatformModule } from '../platform/platform.module';

/**
 * `RecommendationModule` is imported because feed/shorts read through the
 * ranking service before falling back to chronological. There is no cycle:
 * ranking returns ordered IDS only and never reads posts, so posts fetch the
 * ranked ids with the caller's own client (RLS decides visibility).
 *
 * `PlatformModule` powers the write-path policy gates: post creation checks
 * maintenance, the global post_creation switch and the author's own
 * restrictions before the insert.
 */
@Module({
  imports: [AuthModule, RecommendationModule, PlatformModule],
  controllers: [PostsController],
  providers: [PostsService],
  exports: [PostsService],
})
export class PostsModule {}

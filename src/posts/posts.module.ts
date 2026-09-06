import { Module } from '@nestjs/common';
import { PostsController } from './posts.controller';
import { PostsService } from './posts.service';
import { AuthModule } from '../auth/auth.module';
import { RecommendationModule } from '../recommendation/recommendation.module';

/**
 * `RecommendationModule` is imported because feed/shorts read through the
 * ranking service before falling back to chronological. There is no cycle:
 * ranking returns ordered IDS only and never reads posts, so posts fetch the
 * ranked ids with the caller's own client (RLS decides visibility).
 */
@Module({
  imports: [AuthModule, RecommendationModule],
  controllers: [PostsController],
  providers: [PostsService],
  exports: [PostsService],
})
export class PostsModule {}

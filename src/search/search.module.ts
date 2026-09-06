import { Module } from '@nestjs/common';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';
import { PostsModule } from '../posts/posts.module';
import { AuthModule } from '../auth/auth.module';
import { RecommendationModule } from '../recommendation/recommendation.module';

@Module({
  imports: [PostsModule, AuthModule, RecommendationModule],
  controllers: [SearchController],
  providers: [SearchService],
})
export class SearchModule {}

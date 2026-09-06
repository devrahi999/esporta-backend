import { Module } from '@nestjs/common';
import { RecommendationConfigService } from './recommendation-config.service';
import { RecommendationFeaturesService } from './recommendation-features.service';
import { RecommendationService } from './recommendation.service';
import { AdminRecommendationController } from './admin/admin-recommendation.controller';
import { AdminRecommendationService } from './admin/admin-recommendation.service';
import { AuthModule } from '../auth/auth.module';

/**
 * The Recommendation & Ranking Engine (Phase 1).
 *
 * Exports {@link RecommendationService} — the only thing the surfaces need,
 * because it returns ORDERED IDS and never content. Posts and Search import it,
 * rank with it, and then fetch the ids with the caller's own client so RLS
 * decides what is returned. That is why there is no circular dependency between
 * this module and Posts: ranking does not need to read posts.
 *
 * {@link RecommendationFeaturesService} is exported for the internal recompute
 * endpoint (the scheduled feature rebuild).
 */
@Module({
  imports: [AuthModule],
  controllers: [AdminRecommendationController],
  providers: [
    RecommendationConfigService,
    RecommendationFeaturesService,
    RecommendationService,
    AdminRecommendationService,
  ],
  exports: [RecommendationService, RecommendationConfigService, RecommendationFeaturesService],
})
export class RecommendationModule {}

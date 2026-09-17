import { Module } from '@nestjs/common';
import { InternalController } from './internal.controller';
import { DispatchSecretGuard } from './dispatch-secret.guard';
import { PushModule } from '../push/push.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { RecommendationModule } from '../recommendation/recommendation.module';
import { MediaModule } from '../media/media.module';
import { MediaCleanupService } from './media-cleanup.service';

/**
 * Internal machine→backend dispatch endpoints. EmailService comes from the
 * global EmailModule; PushDispatchService from PushModule; the analytics
 * aggregation trigger from AnalyticsModule (exported for this purpose); the
 * recommendation feature rebuild from RecommendationModule — the same pattern,
 * one more scheduled job; and the media cleanup drainer from MediaCleanupService,
 * which pulls in MediaModule for the R2/Stream providers it deletes through.
 */
@Module({
  imports: [PushModule, AnalyticsModule, RecommendationModule, MediaModule],
  controllers: [InternalController],
  providers: [DispatchSecretGuard, MediaCleanupService],
})
export class InternalModule {}

import { Module } from '@nestjs/common';
import { InternalController } from './internal.controller';
import { DispatchSecretGuard } from './dispatch-secret.guard';
import { PushModule } from '../push/push.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { RecommendationModule } from '../recommendation/recommendation.module';

/**
 * Internal machine→backend dispatch endpoints. EmailService comes from the
 * global EmailModule; PushDispatchService from PushModule; the analytics
 * aggregation trigger from AnalyticsModule (exported for this purpose); and the
 * recommendation feature rebuild from RecommendationModule — the same pattern,
 * one more scheduled job.
 */
@Module({
  imports: [PushModule, AnalyticsModule, RecommendationModule],
  controllers: [InternalController],
  providers: [DispatchSecretGuard],
})
export class InternalModule {}

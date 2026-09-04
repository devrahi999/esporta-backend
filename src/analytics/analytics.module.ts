import { Module } from '@nestjs/common';
import { AnalyticsController } from './analytics.controller';
import { AdminAnalyticsController } from './admin-analytics.controller';
import { AnalyticsService } from './analytics.service';
import { AnalyticsReadService } from './analytics-read.service';
import { AnalyticsAggregateService } from './analytics-aggregate.service';
import { AuthModule } from '../auth/auth.module';

/**
 * Analytics Part 1 (ingestion) + Part 2 (aggregation + dashboard reads).
 * The aggregate service is exported so the internal module can wire the
 * scheduled `/webhooks/internal/analytics-aggregate` trigger to it.
 */
@Module({
  imports: [AuthModule],
  controllers: [AnalyticsController, AdminAnalyticsController],
  providers: [AnalyticsService, AnalyticsReadService, AnalyticsAggregateService],
  exports: [AnalyticsAggregateService],
})
export class AnalyticsModule {}

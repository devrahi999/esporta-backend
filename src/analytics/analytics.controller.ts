import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import { AnalyticsReadService } from './analytics-read.service';
import { IngestEventsDto } from './dto/analytics.dto';
import {
  AnalyticsContentQueryDto,
  AnalyticsOverviewQueryDto,
  AnalyticsTopContentQueryDto,
} from './dto/analytics-query.dto';
import { ActiveProfileGuard } from '../auth/guards/active-profile.guard';
import {
  AccessToken,
  ActiveProfileId,
  CurrentUser,
} from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/http/request-context';

/**
 * `/api/v1/analytics`. Batched event ingestion (Part 1) and the identity-
 * scoped dashboard reads (Part 2/3) that the Flutter dashboards call.
 *
 * The read routes are the SAME contract for a personal identity and a team
 * identity: `ActiveProfileGuard` resolves and validates the active profile
 * from `X-Active-Profile-Id` with `can_act_as`, so switching identity in the
 * app switches the dashboard — no separate team endpoint, no second auth path.
 */
@Controller('analytics')
@UseGuards(ActiveProfileGuard)
export class AnalyticsController {
  constructor(
    private readonly analytics: AnalyticsService,
    private readonly reads: AnalyticsReadService,
  ) {}

  @Post('events')
  ingest(
    @AccessToken() token: string,
    @CurrentUser() user: AuthenticatedUser,
    @ActiveProfileId() me: string,
    @Body() dto: IngestEventsDto,
  ) {
    return this.analytics.ingest(token, user.id, me, dto.events);
  }

  // -------------------------------------------------- Part 2/3: dashboard reads
  /**
   * Overview + series for the active identity (personal or team). Pass
   * `compare=true` for the equal-length preceding window and per-card deltas.
   */
  @Get('overview')
  overview(@ActiveProfileId() me: string, @Query() query: AnalyticsOverviewQueryDto) {
    return this.reads.overview(me, query);
  }

  /**
   * Top posts/shorts owned by the active identity. `order` selects the ranking
   * dimension and `offset` paginates; both are resolved in SQL.
   */
  @Get('top-content')
  topContent(@ActiveProfileId() me: string, @Query() query: AnalyticsTopContentQueryDto) {
    return this.reads.topContent(me, query);
  }

  /** Content-performance detail for one of the identity's own posts/shorts. */
  @Get('content/:entityId')
  contentDetail(
    @ActiveProfileId() me: string,
    @Param('entityId') entityId: string,
    @Query() query: AnalyticsContentQueryDto,
  ) {
    return this.reads.contentDetail(me, entityId, query);
  }
}

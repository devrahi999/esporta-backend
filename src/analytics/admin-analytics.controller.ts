import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { AnalyticsReadService } from './analytics-read.service';
import {
  AnalyticsContentQueryDto,
  AnalyticsOverviewQueryDto,
  AnalyticsQueryDto,
  AnalyticsReactionMixQueryDto,
  AnalyticsTopContentQueryDto,
  AnalyticsTopIdentitiesQueryDto,
} from './dto/analytics-query.dto';
import { AdminGuard } from '../admin/guards/admin.guard';

/**
 * `/api/v1/admin/analytics/*` — platform-wide analytics reads for the
 * analytics-admin console. AdminGuard rejects non-admins early; the numbers come
 * from the same daily rollups and the same read service the identity dashboards
 * use, so the admin surface adds scope, never a second calculation path.
 *
 * Every route is a finished answer: ranking, filtering, pagination, averages and
 * ratios are all resolved here, because the console must never compute a metric
 * from two others in the browser.
 *
 * A future `analytics.view` capability can gate these more finely without
 * changing any contract — the payload shapes are what the console depends on.
 */
@Controller('admin/analytics')
@UseGuards(AdminGuard)
export class AdminAnalyticsController {
  constructor(private readonly reads: AnalyticsReadService) {}

  /** Platform totals, derived ratios and series. `compare=true` adds the preceding window. */
  @Get('overview')
  overview(@Query() query: AnalyticsOverviewQueryDto) {
    return this.reads.adminOverview(query);
  }

  /**
   * Whether the numbers are fresh, and when the aggregation last ran. Takes no
   * range: it is a property of the pipeline, not of a window.
   */
  @Get('freshness')
  freshness() {
    return this.reads.adminFreshness();
  }

  /** Top identities, ranked/filtered/paginated in SQL, with display fields. */
  @Get('top-identities')
  topIdentities(@Query() query: AnalyticsTopIdentitiesQueryDto) {
    return this.reads.adminTopIdentities(query);
  }

  /** One identity's full analytics, platform scope — the leaderboard drill-down. */
  @Get('identity/:identityId')
  identityDetail(
    @Param('identityId') identityId: string,
    @Query() query: AnalyticsOverviewQueryDto,
  ) {
    return this.reads.adminIdentityDetail(identityId, query);
  }

  /** Top posts/shorts platform-wide, with the owning identity attached. */
  @Get('top-content')
  topContent(@Query() query: AnalyticsTopContentQueryDto) {
    return this.reads.adminTopContent(query);
  }

  /** One content item's performance, platform scope (no owner restriction). */
  @Get('content/:entityId')
  contentDetail(@Param('entityId') entityId: string, @Query() query: AnalyticsContentQueryDto) {
    return this.reads.adminContentDetail(entityId, query);
  }

  /**
   * Reaction mix by type. Optional `entityId` / `identityId` narrow it to one
   * post or one author. Sourced from the reaction taxonomy, not the rollups —
   * the response says so in `scope.source`.
   */
  @Get('reaction-mix')
  reactionMix(@Query() query: AnalyticsReactionMixQueryDto) {
    return this.reads.adminReactionMix(query);
  }

  /** How content published in the range splits by format, author, media and type. */
  @Get('distribution')
  distribution(@Query() query: AnalyticsQueryDto) {
    return this.reads.adminContentDistribution(query);
  }
}

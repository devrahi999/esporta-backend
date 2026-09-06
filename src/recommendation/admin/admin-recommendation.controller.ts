import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminGuard } from '../../admin/guards/admin.guard';
import {
  AccessToken,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { clampLimit } from '../../common/dto/pagination.dto';
import type { AuthenticatedUser } from '../../common/http/request-context';
import { AdminRecommendationService } from './admin-recommendation.service';
import {
  ActivateConfigVersionDto,
  AdminPagingDto,
  CreateConfigVersionDto,
  CreateInterventionDto,
  InterventionsQueryDto,
  RevokeInterventionDto,
  ValidateConfigDto,
} from './dto/admin-recommendation.dto';

/**
 * `/api/v1/admin/recommendations` — the Phase 2 Recommendation Admin Panel's
 * backend (§24).
 *
 * Built now, with NO UI, because the panel is only safe to build on top of
 * bounded, validated, audited operations — and those are best designed at the
 * same time as the engine they control, not retrofitted. Every route:
 *   * sits behind `AdminGuard` + an in-database capability check;
 *   * is a named domain operation (no generic config write, no arbitrary SQL);
 *   * validates its inputs, including the full config schema on writes;
 *   * writes an audit row for every mutation.
 *
 * Read routes deliberately exclude score internals from nothing — this surface
 * IS the explanation channel (§23); the user-facing feed endpoint carries only
 * the algorithm version label.
 */
@Controller('admin/recommendations')
@UseGuards(AdminGuard)
export class AdminRecommendationController {
  constructor(private readonly admin: AdminRecommendationService) {}

  @Get('overview')
  overview(@AccessToken() token: string) {
    return this.admin.overview(token);
  }

  @Get('config/history')
  history(@AccessToken() token: string, @Query() q: AdminPagingDto) {
    return this.admin.history(token, q.limit ?? 50, q.offset ?? 0);
  }

  @Get('config/:versionId')
  version(@AccessToken() token: string, @Param('versionId') versionId: string) {
    return this.admin.version(token, versionId);
  }

  @Get('audit')
  audit(@AccessToken() token: string, @Query() q: AdminPagingDto) {
    return this.admin.auditLog(token, q.limit ?? 50, q.offset ?? 0);
  }

  @Post('config/validate')
  validate(@Body() dto: ValidateConfigDto) {
    // Stateless and side-effect free — no capability needed.
    return this.admin.validateDraft('', dto.config);
  }

  @Post('config')
  create(
    @AccessToken() token: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateConfigVersionDto,
  ) {
    return this.admin.createDraft(token, user.id, dto);
  }

  @Post('config/:versionId/activate')
  activate(
    @AccessToken() token: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('versionId') versionId: string,
    @Body() dto: ActivateConfigVersionDto,
  ) {
    return this.admin.activate(token, user.id, versionId, dto);
  }

  @Get('features/freshness')
  freshness(@AccessToken() token: string) {
    return this.admin.featureFreshness(token);
  }

  @Get('debug/user/:identityId')
  debugUser(@AccessToken() token: string, @Param('identityId') identityId: string) {
    return this.admin.debugUser(token, identityId);
  }

  @Get('debug/content/:postId')
  debugContent(@AccessToken() token: string, @Param('postId') postId: string) {
    return this.admin.debugContent(token, postId);
  }

  /**
   * Runs the real pipeline with explanations. `limit` is clamped tight because
   * this renders a breakdown per item and is not a data-export path.
   */
  @Get('debug/ranking/:viewerId/:surface')
  debugRanking(
    @AccessToken() token: string,
    @Param('viewerId') viewerId: string,
    @Param('surface') surface: string,
    @Query('limit') limit?: string,
  ) {
    const surfaces = ['feed', 'shorts', 'search'] as const;
    if (!surfaces.includes(surface as (typeof surfaces)[number])) {
      return this.admin.debugRanking({
        actorToken: token,
        viewerId,
        surface: 'feed',
        limit: clampLimit(Number(limit), 20, 50),
      });
    }
    return this.admin.debugRanking({
      actorToken: token,
      viewerId,
      surface: surface as (typeof surfaces)[number],
      limit: clampLimit(Number(limit), 20, 50),
    });
  }

  /**
   * The identity-search debugger: lexical matches + ranked order + per-component
   * score breakdowns for a viewer's profile/team query. `kind` selects the
   * entity surface; `limit` clamped tight as this renders a breakdown per item.
   */
  @Get('debug/identity-search/:viewerId')
  debugIdentitySearch(
    @AccessToken() token: string,
    @Param('viewerId') viewerId: string,
    @Query('kind') kind?: string,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
  ) {
    const targetKind = kind === 'team' ? 'team' : 'personal';
    return this.admin.debugIdentitySearch({
      actorToken: token,
      viewerId,
      targetKind,
      query: q ?? '',
      limit: clampLimit(Number(limit), 20, 50),
    });
  }

  @Get('interventions')
  interventions(@AccessToken() token: string, @Query() q: InterventionsQueryDto) {
    return this.admin.listInterventions(token, q.includeExpired === 'true');
  }

  @Post('interventions')
  createIntervention(
    @AccessToken() token: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateInterventionDto,
  ) {
    return this.admin.createIntervention(token, user.id, dto);
  }

  @Post('interventions/:id/revoke')
  revokeIntervention(
    @AccessToken() token: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: RevokeInterventionDto,
  ) {
    return this.admin.revokeIntervention(token, user.id, id, dto.note);
  }

  /** Operator-triggered feature rebuild — same code path as the cron. */
  @Post('rebuild')
  rebuild(@AccessToken() token: string) {
    return this.admin.rebuildNow(token);
  }
}

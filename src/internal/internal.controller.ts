import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsEmail, IsInt, IsOptional, Max, MaxLength, Min } from 'class-validator';
import { PushDispatchService } from '../push/push-dispatch.service';
import { EmailService } from '../email/email.service';
import { AnalyticsAggregateService } from '../analytics/analytics-aggregate.service';
import { RecommendationFeaturesService } from '../recommendation/recommendation-features.service';
import { RecommendationConfigService } from '../recommendation/recommendation-config.service';
import { DispatchSecretGuard } from './dispatch-secret.guard';
import { Public } from '../common/decorators/public.decorator';

class AggregateDaysDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(92) days?: number;
}

class EmailDiagnosticDto {
  /** Optional. When present, a plain test message is actually delivered here. */
  @IsOptional() @IsEmail() @MaxLength(254) to?: string;
}

/**
 * `/api/v1/webhooks/internal/*`. Machine→backend calls, gated by the dispatch
 * secret rather than a user JWT — so `@Public()` skips the JWT guard and
 * {@link DispatchSecretGuard} enforces the shared secret (either its own
 * header or an `Authorization: Bearer` form — see the guard).
 *
 * `analytics-aggregate` is the Part 2 scheduling hook. The scheduler is
 * EXTERNAL (cron-job.org), not Vercel Cron: it sends one authenticated request
 * per day at 00:15 UTC, which recomputes the trailing window so late-arriving
 * events land in the right day bucket and a failed run self-heals the next
 * night. The endpoint is never public — no secret, no aggregation.
 */
@Public()
@UseGuards(DispatchSecretGuard)
@Controller('webhooks/internal')
export class InternalController {
  constructor(
    private readonly pushDispatch: PushDispatchService,
    private readonly email: EmailService,
    private readonly analyticsAggregate: AnalyticsAggregateService,
    private readonly recoFeatures: RecommendationFeaturesService,
    private readonly recoConfig: RecommendationConfigService,
  ) {}

  @Post('push-dispatch')
  dispatch() {
    return this.pushDispatch.dispatch();
  }

  /**
   * SMTP diagnostic. Replaces the throwaway `email-diagnostic` Edge Function:
   * the sender now lives here, so the probe must exercise THIS transporter.
   *
   * With no body it connects and authenticates only (nodemailer `verify()`), so
   * it is safe to run against production without mailing anyone. Pass `{"to":…}`
   * to prove end-to-end delivery with a message that carries no code and no link.
   *
   * Reports credentials as presence booleans and a length — never a value — and
   * routes provider replies through the same sanitiser the sender uses.
   */
  @Post('email-diagnostics')
  async emailDiagnostics(@Body() dto: EmailDiagnosticDto) {
    const config = this.email.configSummary();
    if (!config.configured) {
      return {
        ok: false,
        verdict: 'smtp_not_configured',
        missing: config.missing,
        config,
      };
    }

    const auth = await this.email.verifyTransport();
    if (!auth.sent) {
      return {
        ok: false,
        // 535 from Gmail here means the App Password is revoked or wrong.
        verdict: auth.failureKind === 'EAUTH' ? 'auth_failed' : 'connect_or_protocol_failed',
        config,
        connection: auth,
      };
    }

    if (!dto.to) {
      return { ok: true, verdict: 'auth_ok', config, connection: auth };
    }

    const delivery = await this.email.sendDiagnostic(dto.to);
    return {
      ok: delivery.sent,
      verdict: delivery.sent ? 'delivered_to_provider' : 'send_rejected',
      config,
      connection: auth,
      delivery,
    };
  }

  /** GET — the shape the external scheduler (cron-job.org) sends. */
  @Get('analytics-aggregate')
  aggregateCron() {
    return this.analyticsAggregate.runRecent(7);
  }

  /** POST — manual trigger (ops backfill) with an explicit window. */
  @Post('analytics-aggregate')
  aggregateManual(@Body() dto: AggregateDaysDto) {
    return this.analyticsAggregate.runRecent(dto.days ?? 7);
  }

  /**
   * The recommendation feature rebuild (Recommendation Phase 1, §38/§39).
   *
   * Recomputes content, identity and user features from the daily analytics
   * rollups, prunes the exposure ring buffer, and passes the ACTIVE config's
   * signal weights and decay into SQL — so retuning the interest model takes
   * effect here without a deploy. The ACTIVE config version id is stamped into
   * the result, making every feature state traceable to the config that produced
   * it.
   *
   * Scheduled like `analytics-aggregate`: one authenticated GET per day. It
   * must run AFTER aggregation (features read the rollups), so the existing
   * 00:15 UTC analytics job is followed by this one at 00:45 UTC — a separate
   * cron entry on cron-job.org, the same external-scheduler pattern, and never
   * an in-process scheduler (Vercel has no long-lived workers).
   *
   * Idempotent and self-healing: every table is recompute-and-replace, so a
   * missed night is corrected by the next run and a re-run is a no-op.
   */
  @Get('recommendations-rebuild')
  async recommendationsRebuildCron() {
    const { config, versionId } = await this.recoConfig.active();
    const result = await this.recoFeatures.rebuildAll(config);
    return { configVersionId: versionId, result };
  }

  @Post('recommendations-rebuild')
  async recommendationsRebuildManual() {
    const { config, versionId } = await this.recoConfig.active();
    const result = await this.recoFeatures.rebuildAll(config);
    return { configVersionId: versionId, result };
  }
}

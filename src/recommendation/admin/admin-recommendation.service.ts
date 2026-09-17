import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../../supabase/supabase.service';
import { AppException } from '../../common/errors/app-exception';
import { isUuid } from '../../common/utils/uuid';
import { RecommendationConfigService } from '../recommendation-config.service';
import { RecommendationFeaturesService } from '../recommendation-features.service';
import { RecommendationService } from '../recommendation.service';
import {
  validateRecommendationConfig,
  type RecommendationConfig,
  type RecommendationSurface,
} from '../config/recommendation-config.schema';

/**
 * The admin operations the Phase 2 Recommendation Admin Panel will call.
 *
 * The endpoints are the BOUNDED, DOMAIN-SHAPED surface (§24): get active config,
 * history, validate a draft, activate/rollback, inspect a viewer's profile, a
 * post's features, the candidate pool and the score breakdown. There is
 * deliberately no generic "set score", no arbitrary config write and no raw SQL
 * — every mutation is a named operation that validates its inputs and writes an
 * audit row.
 *
 * Authorization is layered exactly like core-admin's:
 *   1. `AdminGuard` (class level) — the caller must be a live admin;
 *   2. an `admin_require('<cap>')` RPC per call — the capability check happens
 *      in the database, in the same transaction as the write, so a
 *      misconfigured route cannot bypass it;
 *   3. everything the panel sees is read through `service_role` RPCs, which is
 *      safe here because the guard has already established the caller is an
 *      admin — the same posture as every `admin_*` function core-admin uses.
 *
 * The `recommendations.*` capability family is declared in
 * `admin_capability_ids()` (superadmin holds all of it). Granting the family to
 * other admin levels happens through the existing roles matrix in Phase 2 — a
 * `recommendations.manage` row for `admin` is a console decision, not a code
 * change.
 */
const CAP_VIEW = 'recommendations.view';
const CAP_MANAGE = 'recommendations.manage';
const CAP_DEBUG = 'recommendations.debug';

@Injectable()
export class AdminRecommendationService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly config: RecommendationConfigService,
    private readonly features: RecommendationFeaturesService,
    private readonly ranking: RecommendationService,
  ) {}

  // ------------------------------------------------------------------ reads

  /** The active config + version, or the built-in defaults when none is active. */
  async overview(actorToken: string): Promise<unknown> {
    await this.requireCap(actorToken, CAP_VIEW);
    const active = await this.config.active();
    const freshness = await this.features.featureFreshness();
    return {
      activeVersion: {
        id: active.versionId,
        label: active.versionLabel,
        fallback: active.fallback,
      },
      config: active.config,
      featureFreshness: freshness,
    };
  }

  async history(actorToken: string, limit: number, offset: number): Promise<unknown> {
    await this.requireCap(actorToken, CAP_VIEW);
    return this.config.history(limit, offset);
  }

  async version(actorToken: string, versionId: string): Promise<unknown> {
    await this.requireCap(actorToken, CAP_VIEW);
    if (!isUuid(versionId)) throw AppException.validation('Invalid version id.');
    return this.config.version(versionId);
  }

  async auditLog(actorToken: string, limit: number, offset: number): Promise<unknown> {
    await this.requireCap(actorToken, CAP_VIEW);
    return this.config.auditLog(limit, offset);
  }

  /**
   * Validates a draft WITHOUT storing anything. The panel's "check before
   * publish" affordance — and the cheapest way for a future CI job to prove a
   * checked-in config still satisfies the schema.
   */
  async validateDraft(_actorToken: string, config: unknown): Promise<unknown> {
    // Read-only and side-effect free; capability gate intentionally omitted.
    return this.config.validateDraft(config);
  }

  /** Why a surface is (not) ranked: config freshness, staleness, per-table rows. */
  async featureFreshness(actorToken: string): Promise<unknown> {
    await this.requireCap(actorToken, CAP_VIEW);
    return this.features.featureFreshness();
  }

  /**
   * The user debugger: one viewer's full recommendation profile — scalar
   * features, topic affinities, top identities, recent exposures.
   */
  async debugUser(actorToken: string, identityId: string): Promise<unknown> {
    await this.requireCap(actorToken, CAP_DEBUG);
    if (!isUuid(identityId)) throw AppException.validation('Invalid identity id.');
    return this.features.debugUserProfile(identityId);
  }

  /**
   * The content debugger: a post's features, its author's features, the explicit
   * eligibility verdict for every rule, and any live interventions.
   */
  async debugContent(actorToken: string, postId: string): Promise<unknown> {
    await this.requireCap(actorToken, CAP_DEBUG);
    if (!isUuid(postId)) throw AppException.validation('Invalid post id.');
    return this.features.debugContent(postId);
  }

  /**
   * The ranking debugger (§24: "inspect candidate list / score breakdown / why
   * recommended").
   *
   * Runs the REAL pipeline for a viewer and surface and returns the full slate
   * WITH explanations — the same rows, the same config and the same code the
   * production read uses, so what the debugger explains is what actually
   * happened. DRY-RUN: nothing is recorded to the exposure log.
   *
   * `previewConfigVersionId` dry-runs a DRAFT version against real data;
   * `previewControls` simulates a viewer-control document without applying it.
   */
  async debugRanking(params: {
    actorToken: string;
    viewerId: string;
    surface: RecommendationSurface;
    limit: number;
    previewConfigVersionId?: string;
    query?: string;
    previewControls?: {
      multipliers: Record<string, number>;
      exploration: 'low' | 'default' | 'high';
    };
  }): Promise<unknown> {
    await this.requireCap(params.actorToken, CAP_DEBUG);
    if (!isUuid(params.viewerId)) throw AppException.validation('Invalid viewer id.');

    let previewConfig: {
      config: RecommendationConfig;
      versionId: string;
      versionLabel: string;
    } | undefined;
    if (params.previewConfigVersionId) {
      if (!isUuid(params.previewConfigVersionId)) {
        throw AppException.validation('Invalid preview version id.');
      }
      const version = (await this.config.version(params.previewConfigVersionId)) as {
        id?: string;
        version_label?: string;
        config?: unknown;
      };
      const validation = validateRecommendationConfig(version.config);
      if (!validation.valid || !validation.config) {
        throw AppException.unprocessable(
          'That version no longer satisfies the current schema and cannot be previewed.',
          undefined,
          { issues: validation.issues },
        );
      }
      previewConfig = {
        config: validation.config,
        versionId: version.id ?? params.previewConfigVersionId,
        versionLabel: version.version_label ?? 'preview',
      };
    }

    // Search debug runs the lexical layer first (as production does), then
    // ranks the matched ids.
    let relevance: Map<string, number> | undefined;
    let restrictTo: string[] | undefined;
    if (params.surface === 'search') {
      const q = (params.query ?? '').trim();
      if (!q) throw AppException.validation('Query "q" is required for the search surface.');
      const lexical = await this.supabase.rpcAsCaller<
        Array<{ id: string; score: number | string }> | null
      >(params.actorToken, 'search_post_ids', {
        q,
        max_rows: Math.max(params.limit, 50),
      });
      const matches = (lexical ?? []).map((r) => ({
        id: r.id,
        score: typeof r.score === 'number' ? r.score : Number(r.score) || 0,
      }));
      relevance = new Map(matches.map((m) => [m.id, m.score]));
      restrictTo = matches.map((m) => m.id);
    }

    const slate = await this.ranking.rank({
      viewerId: params.viewerId,
      surface: params.surface,
      limit: params.limit,
      includeExplanations: true,
      dryRun: true,
      relevance,
      restrictTo,
      previewConfig,
      previewControls: params.previewControls,
    });

    return {
      meta: slate.meta,
      fallback: slate.fallback,
      fallbackReason: slate.fallbackReason,
      postIds: slate.postIds,
      explanations: slate.explanations ?? {},
      dropped: slate.dropped ?? [],
    };
  }

  /**
   * The identity-search debugger (Phase 2 "why recommended" for profiles/teams).
   *
   * Runs the REAL lexical+ranked pipeline for a viewer and query and returns the
   * ranked identity ids WITH per-component score breakdowns and the restricted
   * drop count — the same code and config the production search read uses, so
   * what the debugger explains is what actually happened.
   */
  async debugIdentitySearch(params: {
    actorToken: string;
    viewerId: string;
    targetKind: 'personal' | 'team';
    query: string;
    limit: number;
  }): Promise<unknown> {
    await this.requireCap(params.actorToken, CAP_DEBUG);
    if (!isUuid(params.viewerId)) throw AppException.validation('Invalid viewer id.');
    const q = params.query.trim();
    if (!q) throw AppException.validation('Query "q" is required.');

    // The lexical layer runs on the ADMIN's caller token, not the debug target's
    // — it is a read of who matches a public query. RLS on identities is
    // "readable unless deleted", identical for both tokens; the debug target's
    // personalisation is what the service-role bundle supplies below.
    const lexical = await this.supabase.rpcAsCaller<
      Array<{ id: string; score: number | string }> | null
    >(params.actorToken, 'search_identity_ids', {
      q,
      target_kind: params.targetKind,
      max_rows: params.limit,
    });
    const matches = (lexical ?? []).map((r) => ({
      id: r.id,
      score: typeof r.score === 'number' ? r.score : Number(r.score) || 0,
    }));
    if (matches.length === 0) {
      return { lexical: [], rankedIds: [], explanations: {}, restrictedDropped: 0 };
    }

    const ranked = await this.ranking.rankIdentitySearch({
      viewerId: params.viewerId,
      relevance: new Map(matches.map((m) => [m.id, m.score])),
      identityIds: matches.map((m) => m.id),
      includeExplanations: true,
    });

    return {
      lexical: matches,
      rankedIds: ranked.rankedIds,
      fallback: ranked.fallback,
      fallbackReason: ranked.fallbackReason,
      algorithmVersion: ranked.algorithmVersion,
      configVersionId: ranked.configVersionId,
      explanations: ranked.explanations ?? {},
      restrictedDropped: ranked.restrictedDropped,
    };
  }

  // ----------------------------------------------------------------- writes

  /**
   * Creates a DRAFT config version. Never activates — publishing is a separate,
   * separately audited decision, so a mistyped weight cannot reach production in
   * one call.
   */
  async createDraft(actorToken: string, actorUserId: string, dto: {
    label: string;
    config: unknown;
    notes?: string;
  }): Promise<unknown> {
    await this.requireCap(actorToken, CAP_MANAGE);
    return this.config.createDraft({ ...dto, actorUserId });
  }

  /**
   * Activates a version — or rolls back to an older one, which is the same
   * operation with a different audit verb. The DB guarantees exactly one active
   * version atomically; the previous one is retired, not deleted, so rollback is
   * always available.
   */
  async activate(actorToken: string, actorUserId: string, versionId: string, dto: {
    note?: string;
    rollback?: boolean;
  }): Promise<unknown> {
    await this.requireCap(actorToken, CAP_MANAGE);
    if (!isUuid(versionId)) throw AppException.validation('Invalid version id.');
    return this.config.activate({
      versionId,
      actorUserId,
      note: dto.note,
      rollback: dto.rollback,
    });
  }

  /**
   * Creates a bounded, expiring intervention.
   *
   * Boost/suppression ONLY — there is no "hide" or "always show first", because
   * visibility is an eligibility decision and eligibility is computed from the
   * product's own tables, never from this one (§25). An intervention can reorder
   * what policy allows; it cannot change what policy allows.
   */
  async createIntervention(actorToken: string, actorUserId: string, dto: {
    scope: 'post' | 'identity';
    scopeId: string;
    kind: 'boost' | 'suppress';
    multiplier: number;
    reason: string;
    expiresAt: string;
    surface?: 'feed' | 'shorts' | 'search';
  }): Promise<unknown> {
    await this.requireCap(actorToken, CAP_MANAGE);
    return this.supabase.rpcAsService('reco_intervention_create', {
      p_scope: dto.scope,
      p_scope_id: dto.scopeId,
      p_kind: dto.kind,
      p_multiplier: dto.multiplier,
      p_reason: dto.reason,
      p_expires_at: dto.expiresAt,
      p_surface_id: dto.surface ?? null,
      p_actor: actorUserId,
    });
  }

  async revokeIntervention(actorToken: string, actorUserId: string, id: string, note?: string): Promise<unknown> {
    await this.requireCap(actorToken, CAP_MANAGE);
    if (!isUuid(id)) throw AppException.validation('Invalid intervention id.');
    return this.supabase.rpcAsService('reco_intervention_revoke', {
      p_id: id,
      p_actor: actorUserId,
      p_note: note ?? null,
    });
  }

  async listInterventions(actorToken: string, includeExpired: boolean): Promise<unknown> {
    await this.requireCap(actorToken, CAP_VIEW);
    return this.supabase.rpcAsService('reco_interventions_list', {
      p_include_expired: includeExpired,
      p_limit: 200,
    });
  }

  // ------------------------------------------------- Phase 2 analytics reads

  async exposureOverview(
    actorToken: string,
    from: string,
    to: string,
    surface?: string,
  ): Promise<unknown> {
    await this.requireCap(actorToken, CAP_VIEW);
    const { fromDate, toDate } = this.validWindow(from, to);
    return this.supabase.rpcAsService('reco_exposure_overview', {
      p_from: fromDate,
      p_to: toDate,
      p_surface: surface ?? null,
    });
  }

  async exposureTopPosts(
    actorToken: string,
    q: { from: string; to: string; surface?: string; kind?: string; limit?: number; offset?: number },
  ): Promise<unknown> {
    await this.requireCap(actorToken, CAP_VIEW);
    const { fromDate, toDate } = this.validWindow(q.from, q.to);
    return this.supabase.rpcAsService('reco_exposure_top_posts', {
      p_from: fromDate,
      p_to: toDate,
      p_surface: q.surface ?? null,
      p_kind: q.kind ?? 'all',
      p_limit: q.limit ?? 25,
      p_offset: q.offset ?? 0,
    });
  }

  async exposureTopCreators(
    actorToken: string,
    q: { from: string; to: string; surface?: string; limit?: number; offset?: number },
  ): Promise<unknown> {
    await this.requireCap(actorToken, CAP_VIEW);
    const { fromDate, toDate } = this.validWindow(q.from, q.to);
    return this.supabase.rpcAsService('reco_exposure_top_creators', {
      p_from: fromDate,
      p_to: toDate,
      p_surface: q.surface ?? null,
      p_limit: q.limit ?? 25,
      p_offset: q.offset ?? 0,
    });
  }

  async exposureTopGames(
    actorToken: string,
    q: { from: string; to: string; surface?: string; limit?: number },
  ): Promise<unknown> {
    await this.requireCap(actorToken, CAP_VIEW);
    const { fromDate, toDate } = this.validWindow(q.from, q.to);
    return this.supabase.rpcAsService('reco_exposure_top_games', {
      p_from: fromDate,
      p_to: toDate,
      p_surface: q.surface ?? null,
      p_limit: q.limit ?? 25,
    });
  }

  async contentStats(
    actorToken: string,
    q: { search?: string; kind?: string; status?: string; sort?: string; limit?: number; offset?: number },
  ): Promise<unknown> {
    await this.requireCap(actorToken, CAP_VIEW);
    return this.supabase.rpcAsService('reco_content_stats', {
      p_search: q.search ?? null,
      p_kind: q.kind ?? 'all',
      p_status: q.status ?? 'all',
      p_sort: q.sort ?? 'exposure',
      p_limit: q.limit ?? 25,
      p_offset: q.offset ?? 0,
    });
  }

  async postExposureHistory(actorToken: string, postId: string, days?: number): Promise<unknown> {
    await this.requireCap(actorToken, CAP_VIEW);
    if (!isUuid(postId)) throw AppException.validation('Invalid post id.');
    return this.supabase.rpcAsService('reco_post_exposure_history', {
      p_post_id: postId,
      p_days: days ?? 30,
    });
  }

  async usersOverview(
    actorToken: string,
    q: { search?: string; coldStart?: string; limit?: number; offset?: number },
  ): Promise<unknown> {
    await this.requireCap(actorToken, CAP_VIEW);
    return this.supabase.rpcAsService('reco_users_overview', {
      p_search: q.search ?? null,
      p_cold_start: q.coldStart ?? 'all',
      p_limit: q.limit ?? 25,
      p_offset: q.offset ?? 0,
    });
  }

  async identityStats(actorToken: string, identityId: string, days?: number): Promise<unknown> {
    await this.requireCap(actorToken, CAP_VIEW);
    if (!isUuid(identityId)) throw AppException.validation('Invalid identity id.');
    return this.supabase.rpcAsService('reco_identity_stats', {
      p_identity_id: identityId,
      p_days: days ?? 30,
    });
  }

  // -------------------------------------------------- viewer control writes

  async setViewerControls(
    actorToken: string,
    actorUserId: string,
    dto: {
      identityId: string;
      surface?: 'feed' | 'shorts' | 'search' | null;
      controls: unknown;
      reason: string;
      expiresAt: string;
    },
  ): Promise<unknown> {
    await this.requireCap(actorToken, CAP_MANAGE);
    if (!isUuid(dto.identityId)) throw AppException.validation('Invalid identity id.');
    const expiry = new Date(dto.expiresAt);
    if (Number.isNaN(expiry.getTime())) {
      throw AppException.validation('expiresAt must be an ISO timestamp.');
    }
    return this.supabase.rpcAsService('reco_viewer_controls_set', {
      p_identity_id: dto.identityId,
      p_surface: dto.surface ?? null,
      p_controls: dto.controls,
      p_reason: dto.reason,
      p_expires_at: expiry.toISOString(),
      p_actor: actorUserId,
    });
  }

  async revokeViewerControls(
    actorToken: string,
    actorUserId: string,
    identityId: string,
    surface: 'feed' | 'shorts' | 'search' | null,
    note?: string,
  ): Promise<unknown> {
    await this.requireCap(actorToken, CAP_MANAGE);
    if (!isUuid(identityId)) throw AppException.validation('Invalid identity id.');
    return this.supabase.rpcAsService('reco_viewer_controls_revoke', {
      p_identity_id: identityId,
      p_surface: surface,
      p_actor: actorUserId,
      p_note: note ?? null,
    });
  }

  async getViewerControls(actorToken: string, identityId: string, surface: string): Promise<unknown> {
    await this.requireCap(actorToken, CAP_VIEW);
    if (!isUuid(identityId)) throw AppException.validation('Invalid identity id.');
    return this.supabase.rpcAsService('reco_viewer_controls_get', {
      p_identity_id: identityId,
      p_surface: surface,
    });
  }

  // ------------------------------------------------------------- experiments

  async listExperiments(actorToken: string): Promise<unknown> {
    await this.requireCap(actorToken, CAP_VIEW);
    return this.supabase.rpcAsService('reco_experiments_list');
  }

  async createExperiment(
    actorToken: string,
    actorUserId: string,
    dto: {
      name: string;
      description?: string;
      surface: 'feed' | 'shorts' | 'search';
      variantVersionId: string;
      variantPercent: number;
    },
  ): Promise<unknown> {
    await this.requireCap(actorToken, CAP_MANAGE);
    if (!isUuid(dto.variantVersionId)) {
      throw AppException.validation('Invalid variant version id.');
    }
    return this.supabase.rpcAsService('reco_experiment_create', {
      p_name: dto.name,
      p_description: dto.description ?? null,
      p_surface: dto.surface,
      p_variant_version_id: dto.variantVersionId,
      p_variant_percent: dto.variantPercent,
      p_actor: actorUserId,
    });
  }

  async startExperiment(actorToken: string, actorUserId: string, experimentId: string): Promise<unknown> {
    await this.requireCap(actorToken, CAP_MANAGE);
    if (!isUuid(experimentId)) throw AppException.validation('Invalid experiment id.');
    return this.supabase.rpcAsService('reco_experiment_start', {
      p_experiment_id: experimentId,
      p_actor: actorUserId,
    });
  }

  async stopExperiment(
    actorToken: string,
    actorUserId: string,
    experimentId: string,
    reason?: string,
  ): Promise<unknown> {
    await this.requireCap(actorToken, CAP_MANAGE);
    if (!isUuid(experimentId)) throw AppException.validation('Invalid experiment id.');
    return this.supabase.rpcAsService('reco_experiment_stop', {
      p_experiment_id: experimentId,
      p_actor: actorUserId,
      p_reason: reason ?? null,
    });
  }

  /**
   * Triggers the feature rebuild (§38). Same code the cron uses, callable by an
   * operator after a config change that should apply before the next schedule.
   */
  async rebuildNow(actorToken: string): Promise<unknown> {
    await this.requireCap(actorToken, CAP_MANAGE);
    const { config } = await this.config.active();
    return this.features.rebuildAll(config);
  }

  // ------------------------------------------------------------------- authz

  /**
   * The capability check, executed IN THE DATABASE.
   *
   * Done via an RPC rather than decoded JWT claims because `admin_require` is
   * the single source of truth every other admin surface uses: it reads the live
   * `admin_role_capabilities` rows, raises a 42501 with the
   * `missing_capability` hint when denied, and cannot be spoofed by a token
   * claim.
   */
  private async requireCap(token: string, cap: string): Promise<void> {
    await this.supabase.rpcAsCaller(token, 'admin_require', { cap });
  }

  /**
   * Validates and bounds a date window: ISO dates (YYYY-MM-DD), from ≤ to,
   * window ≤ 366 days, `to` not in the future. The bound is what keeps an
   * analytics query from scanning an unbounded series.
   */
  private validWindow(from: string, to: string): { fromDate: string; toDate: string } {
    const fromPattern = /^\d{4}-\d{2}-\d{2}$/;
    if (!fromPattern.test(from) || !fromPattern.test(to)) {
      throw AppException.validation('from and to must be ISO dates (YYYY-MM-DD).');
    }
    const fromDate = new Date(`${from}T00:00:00Z`);
    const toDate = new Date(`${to}T00:00:00Z`);
    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
      throw AppException.validation('from and to must be valid dates.');
    }
    if (fromDate > toDate) {
      throw AppException.validation('from must not be after to.');
    }
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    if (toDate > today) {
      throw AppException.validation('to must not be in the future.');
    }
    if ((toDate.getTime() - fromDate.getTime()) / 86_400_000 > 366) {
      throw AppException.validation('The window cannot exceed 366 days.');
    }
    return { fromDate: from, toDate: to };
  }
}

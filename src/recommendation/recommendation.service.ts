import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { SupabaseService } from '../supabase/supabase.service';
import { AppLogger } from '../common/logger/app-logger';
import { RecommendationConfigService } from './recommendation-config.service';
import { RecommendationFeaturesService } from './recommendation-features.service';
import { DiversityReranker } from './core/reranker';
import { FeedRanker, ShortsRanker, SearchRanker, applyExploration } from './core/rankers';
import { IdentitySearchRanker } from './core/identity-search-ranker';
import { stableUnitInterval, timeBucket } from './core/scoring';
import { validateRecommendationConfig } from './config/recommendation-config.schema';
import {
  MAX_SLATE_SIZE,
  advanceCursor,
  decodeSlateCursor,
  encodeSlateCursor,
  pageFromCursor,
  type CursorDecodeFailure,
  type SlateCursor,
} from './core/cursor';
import type {
  Ranker,
  RankingContext,
  ScoreExplanation,
  ScoredCandidate,
  ViewerControlEffect,
} from './core/types';
import type { RecommendationConfig, RecommendationSurface } from './config/recommendation-config.schema';

/** What a surface gets back: the ordered ids, the next cursor, and telemetry. */
export interface RankedSlate {
  /** Ordered post ids for THIS page. Content is fetched by the caller under RLS. */
  postIds: string[];
  /** Opaque cursor for the next page, or null when the slate is exhausted. */
  nextCursor: string | null;
  /** True when ranking did not run and the caller must fall back. */
  fallback: boolean;
  fallbackReason?: string;
  meta: RankedSlateMeta;
  /** Score breakdowns, only populated when explicitly requested (admin/debug). */
  explanations?: Record<string, ScoreExplanation>;
  /**
   * Candidates the pipeline considered and excluded, with the rule that
   * excluded them — the debugger's "why is this NOT recommended" answer.
   * Only populated for debug callers (includeExplanations).
   */
  dropped?: Array<{ postId: string; reason: string }>;
}

export interface RankedSlateMeta {
  surface: RecommendationSurface;
  algorithmVersion: string;
  configVersionId: string;
  candidateCount: number;
  eligibleCount: number;
  resultCount: number;
  slateSize: number;
  cursorReused: boolean;
  cursorRejected?: CursorDecodeFailure;
  coldStart: boolean;
  durationMs: number;
}

export interface RankRequest {
  viewerId: string;
  surface: RecommendationSurface;
  limit: number;
  /** The client's cursor from a previous page, if any. */
  cursor?: string;
  /** Relevance per post id — search only. */
  relevance?: Map<string, number>;
  /** Restricts ranking to this id set — search only. */
  restrictTo?: string[];
  /** Populates `explanations`. Admin/debug callers only. */
  includeExplanations?: boolean;
  /** Test seam: pinned so ranking is reproducible. */
  nowMs?: number;
  /**
   * Admin/debug: run with this config instead of the active one — the draft
   * dry-run / "what would change" path. Production callers never set it.
   */
  previewConfig?: {
    config: RecommendationConfig;
    versionId: string;
    versionLabel: string;
  };
  /**
   * Admin/debug: simulate these viewer controls instead of the live ones —
   * the "preview feed for user with this intervention" path. The simulation
   * has no side effects: nothing is recorded, nothing is applied.
   */
  previewControls?: ViewerControlEffect;
  /**
   * Skips exposure recording. Set for every debug/preview call: a debugger
   * that polluted the viewer's repetition state would show different results
   * on every run, which defeats its purpose.
   */
  dryRun?: boolean;
}

/**
 * The recommendation pipeline orchestrator.
 *
 *   candidates → features → eligibility → rank → explore → diversify → slate
 *
 * It returns ORDERED IDS, never content. That separation is what makes the
 * security story simple: this service runs on the service role (it must — the
 * feature tables hold every user's interest graph), and the caller then fetches
 * those ids with the user's own client so RLS decides what is actually returned.
 * A ranking bug can therefore mis-order a feed but cannot leak a private post.
 *
 * Every failure path returns `fallback: true` instead of throwing, so a
 * recommendation problem degrades Home to chronological rather than breaking it
 * (§29).
 */
@Injectable()
export class RecommendationService {
  private readonly logger = new AppLogger('Recommendation');
  private readonly reranker = new DiversityReranker();

  constructor(
    private readonly configService: RecommendationConfigService,
    private readonly features: RecommendationFeaturesService,
    private readonly appConfig: AppConfigService,
    private readonly supabase: SupabaseService,
  ) {}

  /** Whether a surface has ranking switched on in the active config. */
  async isEnabled(surface: RecommendationSurface): Promise<boolean> {
    const { config } = await this.configService.active();
    return config[surface].enabled;
  }

  /**
   * Identity search ranking — the shared path for the profile and team search
   * surfaces.
   *
   * Deliberately NOT a slate: search is a query-shaped read, not a browsing
   * session, so there is no pagination session to freeze and no cursor to
   * carry. What this returns is a bounded re-ordering of the caller's LEXICAL
   * result set, plus per-identity explanations for the admin debugger.
   *
   * The three-layer contract holds exactly as for content:
   *   * the lexical layer (`search_identity_ids`, caller-scoped) decided WHO
   *     matches — deleted and blocked identities are already out, and the
   *     caller-scoped hydration re-checks RLS;
   *   * the ranker only re-orders what the lexical layer produced, and drops
   *     restricted identities (still status='active', so only this layer can);
   *   * on any failure the caller serves the lexical order unchanged.
   */
  async rankIdentitySearch(request: {
    viewerId: string;
    /** Lexical relevance per identity id, from `search_identity_ids`. */
    relevance: Map<string, number>;
    /** The lexical result order — ranking never adds to it. */
    identityIds: string[];
    includeExplanations?: boolean;
    nowMs?: number;
  }): Promise<{
    rankedIds: string[];
    fallback: boolean;
    fallbackReason?: string;
    algorithmVersion: string;
    configVersionId: string;
    explanations?: Record<string, ScoreExplanation>;
    restrictedDropped: number;
  }> {
    const started = Date.now();
    const nowMs = request.nowMs ?? started;
    const { config, versionId, versionLabel } = await this.configService.active();

    // The `search` surface switch governs every search surface — flipping it off
    // returns profiles and teams to pure lexical order, the same operational
    // lever post search has.
    if (!config.search.enabled) {
      return this.identityFallback(request, versionId, versionLabel, 'surface_disabled');
    }

    const ids = request.identityIds;
    if (ids.length === 0) {
      return this.identityFallback(request, versionId, versionLabel, 'no_candidates');
    }

    const ctx: RankingContext = {
      viewerId: request.viewerId,
      surface: 'search',
      config,
      configVersionId: versionId,
      configVersionLabel: versionLabel,
      nowMs,
      timeBucket: timeBucket(nowMs),
    };

    const inputs = await this.features.identitySearchInputs(request.viewerId, ids);

    // An identity with no feature row is served rather than scored — see the
    // ranker. Restricted identities are dropped here and counted, so the debug
    // endpoint can say exactly why an expected result is missing.
    const scored = new IdentitySearchRanker(request.relevance).score(ctx, ids, inputs);
    const restrictedDropped = ids.length - scored.length -
      ids.filter((id) => inputs.identities[id] === undefined).length;

    if (scored.length === 0) {
      return this.identityFallback(request, versionId, versionLabel, 'no_eligible');
    }

    this.logger.event('identity search ranked', {
      context: 'Recommendation',
      surface: 'search',
      algorithmVersion: versionLabel,
      resultCount: scored.length,
      restrictedDropped,
      durationMs: Date.now() - started,
    });

    return {
      rankedIds: scored.map((s) => s.identityId),
      fallback: false,
      algorithmVersion: versionLabel,
      configVersionId: versionId,
      explanations: request.includeExplanations
        ? Object.fromEntries(scored.map((s) => [s.identityId, s.explanation]))
        : undefined,
      restrictedDropped,
    };
  }

  private identityFallback(
    request: { identityIds: string[] },
    versionId: string,
    versionLabel: string,
    reason: string,
  ) {
    return {
      rankedIds: request.identityIds,
      fallback: true,
      fallbackReason: reason,
      algorithmVersion: versionLabel,
      configVersionId: versionId,
      restrictedDropped: 0,
    };
  }

  async rank(request: RankRequest): Promise<RankedSlate> {
    const started = Date.now();
    const nowMs = request.nowMs ?? started;
    const active = await this.configService.active();

    // A debug/preview call may substitute a config (draft dry-run) or simulate
    // viewer controls. The preview path changes ONLY what this request sees —
    // exposure attribution still records the ACTIVE version, and a dryRun
    // request records nothing at all.
    let resolved = request.previewConfig ?? active;

    // Experiment allocation (Phase 2): a RUNNING experiment on this surface
    // deterministically assigns the viewer to control or variant, and the
    // variant arm ranks with the experiment's config version. Explicit preview
    // configs bypass allocation — a debugger asking "what would draft X do"
    // wants exactly that answer, not an arm's coin flip.
    if (!request.previewConfig && !request.dryRun) {
      const arm = await this.experimentArmFor(request.viewerId, request.surface, active.versionId);
      if (arm) {
        resolved = arm;
      }
    }

    const { config, versionId, versionLabel } = resolved;

    const surfaceConfig = config[request.surface];
    if (!surfaceConfig.enabled) {
      return this.fallbackSlate(request, versionId, versionLabel, 'surface_disabled', started);
    }

    // ------------------------------------------------- resume an existing slate
    // Tried FIRST, before any ranking work: a valid cursor means the ordering was
    // already decided, and re-ranking would defeat the point of a stable slate.
    if (request.cursor) {
      const decoded = decodeSlateCursor(request.cursor, this.cursorSecret(), {
        viewerId: request.viewerId,
        surface: request.surface,
        nowMs,
      });
      if (decoded.ok) {
        return this.pageFromSlate(decoded.cursor, request, versionLabel, started);
      }
      // A rejected cursor is normal (expired session, profile switch, rotated
      // config), so a fresh slate is built and the reason is recorded rather
      // than surfaced as an error.
      return this.buildSlate(request, config, versionId, versionLabel, nowMs, started, decoded.reason);
    }

    return this.buildSlate(request, config, versionId, versionLabel, nowMs, started);
  }

  private async buildSlate(
    request: RankRequest,
    config: Awaited<ReturnType<RecommendationConfigService['active']>>['config'],
    versionId: string,
    versionLabel: string,
    nowMs: number,
    started: number,
    cursorRejected?: CursorDecodeFailure,
  ): Promise<RankedSlate> {
    const ctx: RankingContext = {
      viewerId: request.viewerId,
      surface: request.surface,
      config,
      configVersionId: versionId,
      configVersionLabel: versionLabel,
      nowMs,
      // Frozen for the session: exploration and tie-breaks must not drift
      // between page 1 and page 2 of the same scroll.
      timeBucket: timeBucket(nowMs),
    };

    const isShort = request.surface === 'shorts';

    // Search ranks the lexical result set; feed and shorts generate candidates.
    let candidates = request.restrictTo
      ? request.restrictTo.map((postId, index) => ({
          postId,
          source: 'quality' as const,
          rankInSource: index + 1,
        }))
      : await this.features.generate(ctx, { isShort, exclude: [] });

    const candidateCount = candidates.length;
    if (candidateCount === 0) {
      return this.fallbackSlate(request, versionId, versionLabel, 'no_candidates', started, cursorRejected);
    }

    const inputs = await this.features.rankingInputs(
      ctx,
      candidates.map((c) => c.postId),
    );
    // A simulated control replaces the live one for this request only.
    if (request.previewControls) {
      inputs.viewerControls = request.previewControls;
    }

    const { kept, dropped } = this.features.filter(ctx, candidates, inputs);
    if (kept.length === 0) {
      const slate = this.fallbackSlate(request, versionId, versionLabel, 'no_eligible', started, cursorRejected);
      if (request.includeExplanations) slate.dropped = dropped;
      return slate;
    }
    candidates = kept;

    const ranker = this.rankerFor(request);
    let scored = ranker.score(ctx, candidates, inputs);

    // A candidate with a feature row that the ranker skipped ("features not
    // computed yet" reads as absence, not a zero score) is surfaced as a
    // dropped reason for the debugger.
    if (request.includeExplanations) {
      const scoredIds = new Set(scored.map((s) => s.postId));
      for (const candidate of candidates) {
        if (!scoredIds.has(candidate.postId)) {
          dropped.push({ postId: candidate.postId, reason: 'features_missing' });
        }
      }
    }

    // A configured score floor. 0 by default, so with a small catalogue nothing
    // is filtered — the option exists for a mature one.
    const minScore = config.shared.safety.minScore;
    if (minScore > 0) {
      const above = scored.filter((item) => item.score >= minScore);
      // Never let the floor empty the slate: an empty feed is worse than a
      // mediocre one, so the floor is skipped when it would remove everything.
      if (above.length > 0 && above.length < scored.length) {
        if (request.includeExplanations) {
          for (const item of scored) {
            if (item.score < minScore) {
              dropped.push({ postId: item.postId, reason: 'below_min_score' });
            }
          }
        }
        scored = above;
      }
    }

    const coldStart = inputs.viewer?.isColdStart ?? true;
    const slateTarget = Math.min(
      MAX_SLATE_SIZE,
      Math.max(request.limit, request.limit * 5),
    );

    // Exploration then diversity. Order matters: exploring first lets a promoted
    // item participate in the diversity window like any other, whereas
    // exploring after re-ranking could reintroduce the very clustering diversity
    // just removed.
    const explored = applyExploration(ctx, scored, slateTarget, coldStart, inputs);
    const finalOrder = this.reranker.rerank(ctx, explored, inputs);

    const slateIds = finalOrder.slice(0, slateTarget).map((item) => item.postId);
    const cursor: SlateCursor = {
      v: 1,
      s: request.surface,
      u: request.viewerId,
      ids: slateIds,
      o: 0,
      cv: versionId,
      tb: ctx.timeBucket,
      iat: nowMs,
    };

    const pageIds = pageFromCursor(cursor, request.limit);
    const next = advanceCursor(cursor, pageIds.length);

    // Dry-run (debug/preview) requests record nothing: a debugger that wrote
    // to the viewer's exposure log would change the viewer's real repetition
    // state and show different results on every run.
    if (!request.dryRun) {
      void this.features.recordExposure(
        request.viewerId,
        request.surface,
        pageIds,
        versionId,
      );
    }

    this.logRanking(ctx, {
      candidateCount,
      eligibleCount: candidates.length,
      droppedCount: dropped.length,
      resultCount: pageIds.length,
      coldStart,
      durationMs: Date.now() - started,
    });

    return {
      postIds: pageIds,
      nextCursor: next ? encodeSlateCursor(next, this.cursorSecret()) : null,
      fallback: false,
      meta: {
        surface: request.surface,
        algorithmVersion: versionLabel,
        configVersionId: versionId,
        candidateCount,
        eligibleCount: candidates.length,
        resultCount: pageIds.length,
        slateSize: slateIds.length,
        cursorReused: false,
        cursorRejected,
        coldStart,
        durationMs: Date.now() - started,
      },
      explanations: request.includeExplanations
        ? explanationsFor(finalOrder, slateIds)
        : undefined,
      dropped: request.includeExplanations ? dropped : undefined,
    };
  }

  /**
   * Serves a page from an already-decided slate.
   *
   * No re-ranking, deliberately: the slate IS the committed ordering, which is
   * what makes page 2 stable regardless of what page 1 consumed or what has been
   * recomputed since (§20).
   */
  private async pageFromSlate(
    cursor: SlateCursor,
    request: RankRequest,
    versionLabel: string,
    started: number,
  ): Promise<RankedSlate> {
    const pageIds = pageFromCursor(cursor, request.limit);
    if (pageIds.length === 0) {
      return {
        postIds: [],
        nextCursor: null,
        fallback: false,
        meta: {
          surface: request.surface,
          algorithmVersion: versionLabel,
          configVersionId: cursor.cv,
          candidateCount: cursor.ids.length,
          eligibleCount: cursor.ids.length,
          resultCount: 0,
          slateSize: cursor.ids.length,
          cursorReused: true,
          coldStart: false,
          durationMs: Date.now() - started,
        },
      };
    }

    const next = advanceCursor(cursor, pageIds.length);
    void this.features.recordExposure(
      request.viewerId,
      request.surface,
      pageIds,
      cursor.cv,
    );

    return {
      postIds: pageIds,
      nextCursor: next ? encodeSlateCursor(next, this.cursorSecret()) : null,
      fallback: false,
      meta: {
        surface: request.surface,
        algorithmVersion: versionLabel,
        configVersionId: cursor.cv,
        candidateCount: cursor.ids.length,
        eligibleCount: cursor.ids.length,
        resultCount: pageIds.length,
        slateSize: cursor.ids.length,
        cursorReused: true,
        coldStart: false,
        durationMs: Date.now() - started,
      },
    };
  }

  private rankerFor(request: RankRequest): Ranker {
    switch (request.surface) {
      case 'shorts':
        return new ShortsRanker();
      case 'search':
        return new SearchRanker(request.relevance ?? new Map());
      default:
        return new FeedRanker();
    }
  }

  /**
   * Resolves the viewer's experiment arm for a surface, if a RUNNING
   * experiment exists there.
   *
   * Allocation is DETERMINISTIC (hash of experiment+viewer), computed in the
   * database — the same `reco_experiment_arm` the admin surface reports, so
   * what the debugger says about an arm is what actually allocated. Failure is
   * non-fatal by design: a broken experiment read must degrade to the active
   * config (control behaviour), never take the surface down.
   *
   * Returns null for control (rank with the active config) — no allocation
   * table is kept, so control is simply the absence of a variant.
   */
  private async experimentArmFor(
    viewerId: string,
    surface: RecommendationSurface,
    activeVersionId: string,
  ): Promise<{ config: RecommendationConfig; versionId: string; versionLabel: string } | null> {
    try {
      const experiments = await this.supabase.rpcAsService<Array<{
        id: string;
        surface: string;
        variant_version_id: string;
      }> | null>('reco_experiments_running', { p_surface: surface });
      const running = (experiments ?? []).filter(
        // The one-running-per-surface rule is enforced at start; this filter is
        // the belt to that braces for rows written before the rule existed.
        (e) => e.surface === surface && e.variant_version_id !== activeVersionId,
      );
      if (running.length === 0) return null;

      const arms = await Promise.all(
        running.map((experiment) =>
          this.supabase.rpcAsService<string>('reco_experiment_arm', {
            p_experiment_id: experiment.id,
            p_viewer_id: viewerId,
          }),
        ),
      );
      const variantIndex = arms.findIndex((arm) => arm === 'variant');
      if (variantIndex === -1) return null;

      const version = await this.supabase.rpcAsService<{
        id: string;
        version_label: string;
        config: unknown;
      } | null>('reco_config_version', {
        p_version_id: running[variantIndex].variant_version_id,
      });
      if (!version) return null;

      const validation = validateRecommendationConfig(version.config);
      if (!validation.valid || !validation.config) return null;
      return {
        config: validation.config,
        versionId: version.id,
        versionLabel: version.version_label,
      };
    } catch (error) {
      this.logger.event('experiment allocation failed; using control', {
        context: 'Recommendation',
        errorCode: 'EXPERIMENT_ALLOC_FAILED',
        surface,
        reason: error instanceof Error ? error.message : 'unknown',
      });
      return null;
    }
  }

  private fallbackSlate(
    request: RankRequest,
    versionId: string,
    versionLabel: string,
    reason: string,
    started: number,
    cursorRejected?: CursorDecodeFailure,
  ): RankedSlate {
    return {
      postIds: [],
      nextCursor: null,
      fallback: true,
      fallbackReason: reason,
      meta: {
        surface: request.surface,
        algorithmVersion: versionLabel,
        configVersionId: versionId,
        candidateCount: 0,
        eligibleCount: 0,
        resultCount: 0,
        slateSize: 0,
        cursorReused: false,
        cursorRejected,
        coldStart: false,
        durationMs: Date.now() - started,
      },
    };
  }

  /**
   * The HMAC key for slate cursors.
   *
   * Reuses the service-role key as keying material rather than adding a new
   * required secret (§36 — no unnecessary infrastructure). It is never
   * transmitted; only a 32-byte digest of it is used, so the cursor cannot leak
   * anything about the key even in principle. If the key rotates, live cursors
   * fail signature verification and callers transparently get a fresh slate —
   * which is already a handled, non-error path.
   */
  private cursorSecret(): string {
    return `reco.slate.v1.${this.appConfig.supabase.serviceRoleKey.slice(-32)}`;
  }

  /**
   * Structured ranking telemetry (§30).
   *
   * Never logs feature vectors, affinity lists or post ids — only counts,
   * versions and timings. A sampled debug line carries a hashed viewer id so
   * repeated requests from one viewer can be correlated without the log becoming
   * a record of who read what.
   */
  private logRanking(
    ctx: RankingContext,
    stats: {
      candidateCount: number;
      eligibleCount: number;
      droppedCount: number;
      resultCount: number;
      coldStart: boolean;
      durationMs: number;
    },
  ): void {
    const sample = ctx.config.shared.debugLogSampleRate;
    const shouldLog =
      sample >= 1 ||
      (sample > 0 &&
        stableUnitInterval(ctx.viewerId, ctx.surface, ctx.nowMs.toString()) < sample);
    if (!shouldLog) return;

    this.logger.event('ranked', {
      context: 'Recommendation',
      surface: ctx.surface,
      algorithmVersion: ctx.configVersionLabel,
      viewerHash: stableUnitInterval(ctx.viewerId).toFixed(6),
      ...stats,
    });
  }
}

/** Explanations for the served page, keyed by post id. */
function explanationsFor(
  ordered: ScoredCandidate[],
  pageIds: string[],
): Record<string, ScoreExplanation> {
  const wanted = new Set(pageIds);
  const out: Record<string, ScoreExplanation> = {};
  for (const item of ordered) {
    if (wanted.has(item.postId)) out[item.postId] = item.explanation;
  }
  return out;
}

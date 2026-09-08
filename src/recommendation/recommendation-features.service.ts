import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { AppException } from '../common/errors/app-exception';
import { AppLogger } from '../common/logger/app-logger';
import { num } from './core/scoring';
import type {
  Candidate,
  CandidateGeneratorPort,
  CandidateSource,
  ContentFeatures,
  EligibilityFilterPort,
  FeatureProviderPort,
  IdentitySearchInputs,
  RankingContext,
  RankingInputs,
  ViewerFeatures,
  ViewerControlEffect,
} from './core/types';
import { CANDIDATE_SOURCES } from './core/types';
import { signalWeightsForSql, type RecommendationConfig } from './config/recommendation-config.schema';

interface CandidateRow {
  post_id: string;
  source: string;
  rank_in_source: number;
}

/**
 * The data layer for ranking: candidate generation, feature loading, the
 * inputs-derived eligibility pass, and exposure recording.
 *
 * All four go through `service_role` RPCs. That is correct and NOT a weakening
 * of authorization: the feature tables hold every user's interest graph, so no
 * client role may read them. The viewer these calls run for is always the
 * identity the {@link ActiveProfileGuard} already resolved and validated with
 * `can_act_as` — never a client-supplied id — and the ranked ids are afterwards
 * fetched with the CALLER's client, where RLS decides what is actually returned.
 * Ranking sees ids; RLS decides content.
 */
@Injectable()
export class RecommendationFeaturesService
  implements CandidateGeneratorPort, FeatureProviderPort, EligibilityFilterPort
{
  private readonly logger = new AppLogger('RecommendationFeatures');

  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Candidate generation (§8). One RPC, several bounded sources, deduplicated
   * with source attribution preserved.
   *
   * On failure it returns an empty pool rather than throwing: the surface then
   * falls back to chronological ordering (§29), which is a degraded feed instead
   * of no feed.
   */
  async generate(
    ctx: RankingContext,
    options: { isShort: boolean; exclude: string[] },
  ): Promise<Candidate[]> {
    const limits = this.candidateLimits(ctx);
    try {
      const rows = await this.supabase.rpcAsService<CandidateRow[] | null>('reco_candidates', {
        p_viewer_id: ctx.viewerId,
        p_surface: ctx.surface,
        p_is_short: options.isShort,
        p_per_source_limit: limits.perSource,
        p_total_limit: limits.total,
        p_fresh_hours: limits.freshHours,
        p_exclude_post_ids: options.exclude.length > 0 ? options.exclude : null,
        p_cold_start_max_impressions: this.newContentMaxImpressions(ctx),
      });

      return (rows ?? []).map((row) => ({
        postId: row.post_id,
        source: normaliseSource(row.source),
        rankInSource: num(row.rank_in_source, 0),
      }));
    } catch (error) {
      this.logger.event('candidate generation failed', {
        context: 'RecommendationFeatures',
        errorCode: 'CANDIDATES_FAILED',
        surface: ctx.surface,
        reason: error instanceof Error ? error.message : 'unknown',
      });
      return [];
    }
  }

  /**
   * Loads every ranking input for a candidate set in ONE round trip (§27).
   *
   * The alternative — features per post, affinity per author, interventions per
   * post — is 3N queries for an N-candidate pool. Returning empty-but-valid
   * inputs on failure lets the ranker score on freshness alone rather than
   * abandoning the request.
   */
  async rankingInputs(ctx: RankingContext, postIds: string[]): Promise<RankingInputs> {
    if (postIds.length === 0) return emptyInputs();

    const exposureWindow = this.exposureWindowHours(ctx);
    try {
      const raw = await this.supabase.rpcAsService<Record<string, unknown> | null>(
        'reco_ranking_inputs',
        {
          p_viewer_id: ctx.viewerId,
          p_surface: ctx.surface,
          p_post_ids: postIds,
          p_exposure_window_hours: exposureWindow,
        },
      );
      return parseRankingInputs(raw, ctx.viewerId);
    } catch (error) {
      this.logger.event('ranking inputs failed', {
        context: 'RecommendationFeatures',
        errorCode: 'INPUTS_FAILED',
        surface: ctx.surface,
        reason: error instanceof Error ? error.message : 'unknown',
      });
      return emptyInputs();
    }
  }

  /**
   * The inputs-derived eligibility pass.
   *
   * DELIBERATELY NARROW. Deletion, blocking, privacy, restriction and moderation
   * are enforced in `reco_candidates` and, authoritatively, by RLS on the
   * caller-scoped fetch. Those rules are not repeated here, because a rule
   * implemented twice is a rule that can disagree with itself. This pass only
   * applies limits that need the loaded features to evaluate — and note that the
   * config values it reads can only ever make the result STRICTER, never wider.
   */
  filter(
    ctx: RankingContext,
    candidates: Candidate[],
    inputs: RankingInputs,
  ): { kept: Candidate[]; dropped: Array<{ postId: string; reason: string }> } {
    const { maxNegativeRate } = ctx.config.shared.safety;
    const diversity =
      ctx.surface === 'shorts' ? ctx.config.shorts.diversity : ctx.config.feed.diversity;

    const kept: Candidate[] = [];
    const dropped: Array<{ postId: string; reason: string }> = [];

    for (const candidate of candidates) {
      const content = inputs.content[candidate.postId];
      if (!content) {
        // No feature row: the rebuild has not reached this post. Dropped from
        // the ranked slate, not from the product — it still appears in
        // chronological reads, and the next rebuild makes it rankable.
        dropped.push({ postId: candidate.postId, reason: 'features_missing' });
        continue;
      }

      if (content.negativeRate > maxNegativeRate) {
        dropped.push({ postId: candidate.postId, reason: 'negative_rate' });
        continue;
      }

      // Seen too many times already — repetition control's hard stop (§19).
      // Search never drops on exposure: someone searching for a thing wants the
      // thing, however often they have seen it.
      if (ctx.surface !== 'search') {
        const exposure = inputs.exposures[candidate.postId];
        if (exposure && exposure.shown >= diversity.maxExposuresBeforeDrop) {
          dropped.push({ postId: candidate.postId, reason: 'exposure_limit' });
          continue;
        }
      }

      kept.push(candidate);
    }

    return { kept, dropped };
  }

  /**
   * Records what was served, so repetition control and pagination de-duplication
   * survive a refresh, an app restart and a second device (§19).
   *
   * Fire-and-forget: a failure to record must not fail the request that already
   * produced a valid page. The cost of a lost write is one item possibly
   * re-shown, which is a far better outcome than a 500.
   *
   * `configVersionId` attributes the exposure to the config that produced it —
   * the join key for per-version exposure analytics and future experiment arms.
   */
  async recordExposure(
    viewerId: string,
    surface: string,
    postIds: string[],
    configVersionId?: string,
  ): Promise<void> {
    if (postIds.length === 0) return;
    try {
      await this.supabase.rpcAsService('reco_record_exposure', {
        p_viewer_id: viewerId,
        p_surface: surface,
        p_post_ids: postIds,
        p_config_version_id: configVersionId ?? null,
      });
    } catch (error) {
      this.logger.event('exposure recording failed', {
        context: 'RecommendationFeatures',
        errorCode: 'EXPOSURE_FAILED',
        surface,
        reason: error instanceof Error ? error.message : 'unknown',
      });
    }
  }

  /**
   * Loads the identity-search bundle in ONE round trip — viewer, affinities and
   * entity features for exactly the lexical result set (≤ 50 ids). Same
   * anti-N+1 contract as {@link rankingInputs}.
   *
   * Returns an empty-but-valid bundle on failure so a feature-layer hiccup
   * degrades search to plain lexical order instead of erroring.
   */
  async identitySearchInputs(viewerId: string, identityIds: string[]): Promise<IdentitySearchInputs> {
    if (identityIds.length === 0) return emptyIdentityInputs();
    try {
      const raw = await this.supabase.rpcAsService<Record<string, unknown> | null>(
        'reco_identity_ranking_inputs',
        { p_viewer_id: viewerId, p_identity_ids: identityIds },
      );
      return parseIdentitySearchInputs(raw, viewerId);
    } catch (error) {
      this.logger.event('identity search inputs failed', {
        context: 'RecommendationFeatures',
        errorCode: 'IDENTITY_INPUTS_FAILED',
        reason: error instanceof Error ? error.message : 'unknown',
      });
      return emptyIdentityInputs();
    }
  }

  // ------------------------------------------------------------ maintenance

  /**
   * Recomputes every feature table, passing the ACTIVE config's signal weights
   * and decay into SQL — so retuning the interest model from the admin panel
   * takes effect on the next rebuild without a deploy, and the change is
   * attributable to a config version.
   */
  async rebuildAll(config: RecommendationConfig): Promise<unknown> {
    return this.supabase.rpcAsService('reco_rebuild_all', {
      p_recent_days: 14,
      p_lookback_days: config.shared.decay.lookbackDays,
      p_half_life_days: config.shared.decay.interestHalfLifeDays,
      p_signal_weights: signalWeightsForSql(config.shared.signalWeights),
      p_exposure_retention_days: 30,
    });
  }

  async featureFreshness(): Promise<unknown> {
    return this.supabase.rpcAsService('reco_feature_freshness');
  }

  async debugUserProfile(identityId: string): Promise<unknown> {
    const row = await this.supabase.rpcAsService('reco_debug_user_profile', {
      p_identity_id: identityId,
    });
    if (!row) throw AppException.notFound('No recommendation profile for that identity.');
    return row;
  }

  async debugContent(postId: string): Promise<unknown> {
    const row = await this.supabase.rpcAsService('reco_debug_content', { p_post_id: postId });
    if (!row) throw AppException.notFound('No recommendation features for that post.');
    return row;
  }

  // ----------------------------------------------------------------- helpers

  private candidateLimits(ctx: RankingContext) {
    if (ctx.surface === 'feed') return ctx.config.feed.candidateLimits;
    if (ctx.surface === 'shorts') return ctx.config.shorts.candidateLimits;
    return ctx.config.search.candidateLimits;
  }

  private newContentMaxImpressions(ctx: RankingContext): number {
    if (ctx.surface === 'feed') return ctx.config.feed.exploration.newContentMaxImpressions;
    if (ctx.surface === 'shorts') return ctx.config.shorts.exploration.newContentMaxImpressions;
    return 50;
  }

  private exposureWindowHours(ctx: RankingContext): number {
    if (ctx.surface === 'shorts') return ctx.config.shorts.diversity.exposureWindowHours;
    if (ctx.surface === 'feed') return ctx.config.feed.diversity.exposureWindowHours;
    return 24;
  }
}

/** An unknown source string must not crash ranking; it maps to `quality`. */
function normaliseSource(value: string): CandidateSource {
  return (CANDIDATE_SOURCES as readonly string[]).includes(value)
    ? (value as CandidateSource)
    : 'quality';
}

export function emptyInputs(): RankingInputs {
  return {
    viewer: null,
    viewerTopics: {},
    authorAffinity: {},
    authorFeatures: {},
    content: {},
    interventions: {},
    exposures: {},
    viewerControls: { multipliers: {}, exploration: 'default' },
  };
}

/**
 * Parses the `reco_ranking_inputs` jsonb document into typed inputs.
 *
 * Exported so the shape can be unit-tested against a real payload without a
 * database. Every numeric goes through {@link num} because Postgres `numeric`
 * arrives as a string over PostgREST — reading those as numbers directly yields
 * `NaN`, which would propagate silently through every score.
 */
export function parseRankingInputs(raw: unknown, viewerId: string): RankingInputs {
  if (!raw || typeof raw !== 'object') return emptyInputs();
  const doc = raw as Record<string, unknown>;

  return {
    viewer: parseViewer(doc.viewer, viewerId),
    viewerTopics: parseNumberMap(doc.viewer_topics),
    authorAffinity: parseAffinityMap(doc.author_affinity),
    authorFeatures: parseAuthorFeatures(doc.author_features),
    content: parseContentMap(doc.content),
    interventions: parseNumberMap(doc.interventions),
    exposures: parseExposures(doc.exposures),
    viewerControls: parseViewerControls(doc.viewer_controls),
  };
}

/**
 * The viewer control effect — per-key multipliers plus a bounded exploration
 * preference. Defensively tolerant: a missing or malformed section reads as
 * "no controls", never as a parse failure that would degrade the whole bundle.
 */
function parseViewerControls(raw: unknown): ViewerControlEffect {
  if (!raw || typeof raw !== 'object') {
    return { multipliers: {}, exploration: 'default' };
  }
  const doc = raw as Record<string, unknown>;
  const multipliers = parseNumberMap(doc.multipliers);
  const exploration =
    doc.exploration === 'high' || doc.exploration === 'low' ? doc.exploration : 'default';
  return { multipliers, exploration };
}

function parseViewer(raw: unknown, viewerId: string): ViewerFeatures | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Record<string, unknown>;
  return {
    identityId: typeof v.identity_id === 'string' ? v.identity_id : viewerId,
    declaredGameIds: Array.isArray(v.declared_game_ids)
      ? v.declared_game_ids.filter((g): g is string => typeof g === 'string')
      : [],
    declaredRoleId: typeof v.declared_role_id === 'string' ? v.declared_role_id : null,
    followingCount: num(v.following_count),
    shortAffinity: num(v.short_affinity),
    videoAffinity: num(v.video_affinity),
    engagementTendency: num(v.engagement_tendency),
    watchTendency: num(v.watch_tendency),
    avgWatchMs: num(v.avg_watch_ms),
    explorationAppetite: num(v.exploration_appetite),
    interactionCount: num(v.interaction_count),
    confidence: num(v.confidence),
    isColdStart: v.is_cold_start === true,
  };
}

function parseContentMap(raw: unknown): Record<string, ContentFeatures> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, ContentFeatures> = {};
  for (const [postId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const c = value as Record<string, unknown>;
    const createdAt = typeof c.created_at === 'string' ? Date.parse(c.created_at) : NaN;
    out[postId] = {
      authorId: typeof c.author_id === 'string' ? c.author_id : '',
      typeId: typeof c.type_id === 'string' ? c.type_id : 'normal',
      isShort: c.is_short === true,
      gameId: typeof c.game_id === 'string' ? c.game_id : null,
      hasVideo: c.has_video === true,
      // An unparseable timestamp becomes epoch 0, so the item ranks as maximally
      // stale rather than as `NaN` — which would poison every comparison it
      // touched and make the whole ordering non-deterministic.
      createdAtMs: Number.isFinite(createdAt) ? createdAt : 0,
      impressions: num(c.impressions),
      quality: num(c.quality),
      popularity: num(c.popularity),
      engagementRate: num(c.engagement_rate),
      completionRate: num(c.completion_rate),
      avgWatchMs: num(c.avg_watch_ms),
      negativeRate: num(c.negative_rate),
      recentEngagement: num(c.recent_engagement),
      confidence: num(c.confidence),
    };
  }
  return out;
}

function parseAffinityMap(raw: unknown) {
  if (!raw || typeof raw !== 'object') return {};
  const out: RankingInputs['authorAffinity'] = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const a = value as Record<string, unknown>;
    out[id] = {
      score: num(a.score),
      follows: a.follows === true,
      interactions: num(a.interactions),
      negatives: num(a.negatives),
    };
  }
  return out;
}

function parseAuthorFeatures(raw: unknown) {
  if (!raw || typeof raw !== 'object') return {};
  const out: RankingInputs['authorFeatures'] = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const a = value as Record<string, unknown>;
    out[id] = {
      kind: a.kind === 'team' ? 'team' : 'personal',
      quality: num(a.quality),
      popularity: num(a.popularity),
      activity: num(a.activity),
      confidence: num(a.confidence),
    };
  }
  return out;
}

function parseExposures(raw: unknown) {
  if (!raw || typeof raw !== 'object') return {};
  const out: RankingInputs['exposures'] = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const e = value as Record<string, unknown>;
    const last = typeof e.last_shown_at === 'string' ? Date.parse(e.last_shown_at) : NaN;
    out[id] = {
      shown: num(e.shown),
      lastShownAtMs: Number.isFinite(last) ? last : 0,
    };
  }
  return out;
}

function parseNumberMap(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    out[key] = num(value);
  }
  return out;
}

// ------------------------------------------------- identity-search input parsing

export function emptyIdentityInputs(): IdentitySearchInputs {
  return { viewer: null, affinity: {}, identities: {}, interventions: {} };
}

/**
 * Parses the `reco_identity_ranking_inputs` jsonb document into typed inputs.
 *
 * Exported for the same reason as {@link parseRankingInputs}: the wire shape is
 * part of the contract and gets unit-tested against a real payload without a
 * database. Shares {@link parseViewer} and {@link parseAffinityMap} with the
 * content path so the two bundle formats cannot drift apart in how they read
 * the SAME affinity row shape.
 */
export function parseIdentitySearchInputs(raw: unknown, viewerId: string): IdentitySearchInputs {
  if (!raw || typeof raw !== 'object') return emptyIdentityInputs();
  const doc = raw as Record<string, unknown>;

  return {
    viewer: parseViewer(doc.viewer, viewerId),
    affinity: parseAffinityMap(doc.affinity),
    identities: parseSearchIdentityMap(doc.identities),
    interventions: parseNumberMap(doc.interventions),
  };
}

function parseSearchIdentityMap(raw: unknown): IdentitySearchInputs['identities'] {
  if (!raw || typeof raw !== 'object') return {};
  const out: IdentitySearchInputs['identities'] = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const f = value as Record<string, unknown>;
    const lastPost = typeof f.last_post_at === 'string' ? Date.parse(f.last_post_at) : NaN;
    out[id] = {
      kind: f.kind === 'team' ? 'team' : 'personal',
      quality: num(f.quality),
      popularity: num(f.popularity),
      activity: num(f.activity),
      confidence: num(f.confidence),
      primaryGameId: typeof f.primary_game_id === 'string' ? f.primary_game_id : null,
      followers: num(f.followers),
      // An unparseable timestamp reads as 0 (never active), never NaN — a NaN
      // here would poison the freshness comparison and make ordering unstable.
      lastPostAtMs: Number.isFinite(lastPost) ? lastPost : 0,
      restricted: f.restricted === true,
    };
  }
  return out;
}

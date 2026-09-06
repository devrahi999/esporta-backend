import type {
  RecommendationConfig,
  RecommendationSurface,
} from '../config/recommendation-config.schema';

/**
 * The ranking pipeline's contracts (§40 — future ML compatibility).
 *
 * Each stage is an interface so a learned ranker can later replace or wrap the
 * deterministic one WITHOUT touching candidate generation, eligibility,
 * re-ranking, pagination or the surfaces. Phase 1 ships exactly one
 * implementation of {@link Ranker} — a deterministic scorer — and no ML.
 *
 * The stages, in order:
 *   CandidateGenerator → EligibilityFilter → Ranker → Reranker → slate
 */

/** A candidate produced by generation, before any scoring. */
export interface Candidate {
  postId: string;
  /** Which candidate source earned this item a slot. Never collapsed away. */
  source: CandidateSource;
  rankInSource: number;
}

export const CANDIDATE_SOURCES = [
  'following',
  'identity_affinity',
  'interest',
  'trending',
  'cold_start',
  'recent',
  'quality',
] as const;
export type CandidateSource = (typeof CANDIDATE_SOURCES)[number];

/** Per-post ranking features, as returned by `reco_ranking_inputs`. */
export interface ContentFeatures {
  authorId: string;
  typeId: string;
  isShort: boolean;
  gameId: string | null;
  hasVideo: boolean;
  createdAtMs: number;
  impressions: number;
  quality: number;
  popularity: number;
  engagementRate: number;
  completionRate: number;
  avgWatchMs: number;
  negativeRate: number;
  recentEngagement: number;
  confidence: number;
}

/** The viewer's interest model. */
export interface ViewerFeatures {
  identityId: string;
  declaredGameIds: string[];
  declaredRoleId: string | null;
  followingCount: number;
  shortAffinity: number;
  videoAffinity: number;
  engagementTendency: number;
  watchTendency: number;
  avgWatchMs: number;
  explorationAppetite: number;
  interactionCount: number;
  confidence: number;
  isColdStart: boolean;
}

/** Viewer → identity affinity for one author. */
export interface AuthorAffinity {
  score: number;
  follows: boolean;
  interactions: number;
  negatives: number;
}

/** Author-side quality signals. */
export interface AuthorFeatures {
  kind: 'personal' | 'team';
  quality: number;
  popularity: number;
  activity: number;
  confidence: number;
}

/**
 * Entity-side features for identity search — one identity being ranked.
 *
 * Same signals the feed/shorts ranker reads from `reco_identity_features`, plus
 * the search-specific `restricted` flag: a restricted identity is still
 * `status='active'`, so neither the caller-scoped status filter nor RLS drops it
 * from a lexical result set — the ranker is where it must be excluded.
 */
export interface SearchIdentityFeatures {
  kind: 'personal' | 'team';
  quality: number;
  popularity: number;
  activity: number;
  confidence: number;
  primaryGameId: string | null;
  followers: number;
  lastPostAtMs: number;
  restricted: boolean;
}

/**
 * Everything the identity-search ranker needs for one request, from ONE
 * `reco_identity_ranking_inputs` round trip.
 */
export interface IdentitySearchInputs {
  viewer: ViewerFeatures | null;
  /** target identity id → the viewer's affinity for that identity. */
  affinity: Record<string, AuthorAffinity>;
  /** identity id → entity features. */
  identities: Record<string, SearchIdentityFeatures>;
  /** `"identity:<id>"` → composed intervention multiplier. */
  interventions: Record<string, number>;
}

export interface ExposureRecord {
  shown: number;
  lastShownAtMs: number;
}

/**
 * Everything the ranker needs for one request, fetched in ONE round trip.
 *
 * Bundled rather than fetched per candidate because the alternative is 3N
 * queries for an N-candidate pool (§27: avoid N+1).
 */
export interface RankingInputs {
  viewer: ViewerFeatures | null;
  /** `"game:valorant"` / `"content_type:short"` → affinity score. */
  viewerTopics: Record<string, number>;
  authorAffinity: Record<string, AuthorAffinity>;
  authorFeatures: Record<string, AuthorFeatures>;
  content: Record<string, ContentFeatures>;
  /** `"post:<id>"` / `"identity:<id>"` → composed multiplier. */
  interventions: Record<string, number>;
  exposures: Record<string, ExposureRecord>;
}

/**
 * A score with its reasoning attached (§23).
 *
 * `components` and `penalties` are separate maps, and identity affinity is a
 * component in its own right rather than folded into "relevance" — the identity
 * model requires that "by someone you follow" and "about a game you play" stay
 * individually visible, because an operator debugging a bad feed needs to know
 * WHICH of those misfired.
 *
 * Never serialised to a normal client. Only the admin/debug surface exposes it.
 */
export interface ScoreExplanation {
  total: number;
  organic: number;
  components: Record<string, number>;
  penalties: Record<string, number>;
  /** The clamped manual-intervention multiplier, 1 when none applies. */
  interventionMultiplier: number;
  /** True when this slot was filled by the exploration allowance. */
  exploration: boolean;
  source: CandidateSource;
}

export interface ScoredCandidate {
  postId: string;
  authorId: string;
  score: number;
  explanation: ScoreExplanation;
  /** Carried through re-ranking so diversity can act on them. */
  gameId: string | null;
  typeId: string;
  createdAtMs: number;
}

/** Immutable per-request context. `now` is injected so ranking is testable. */
export interface RankingContext {
  viewerId: string;
  surface: RecommendationSurface;
  config: RecommendationConfig;
  configVersionId: string;
  configVersionLabel: string;
  nowMs: number;
  /**
   * Frozen for the whole pagination session, not read per page — otherwise
   * exploration and tie-breaks would drift between page 1 and page 2 of the
   * same scroll.
   */
  timeBucket: number;
}

// ------------------------------------------------------------------- stage ports

export interface CandidateGeneratorPort {
  generate(ctx: RankingContext, options: { isShort: boolean; exclude: string[] }): Promise<Candidate[]>;
}

export interface FeatureProviderPort {
  rankingInputs(ctx: RankingContext, postIds: string[]): Promise<RankingInputs>;
}

/**
 * Post-retrieval eligibility.
 *
 * NOTE ON LAYERING: this is the THIRD eligibility layer, not the only one.
 * Layer 1 is `reco_candidates` (deleted/blocked/restricted/moderated/missing
 * media). Layer 2 is the caller-scoped fetch, where RLS decides what a viewer
 * may actually receive. This layer only handles rules that need the ranking
 * inputs to evaluate — e.g. a negative-feedback rate above the configured
 * ceiling. It is a filter of last resort, never the boundary.
 */
export interface EligibilityFilterPort {
  filter(
    ctx: RankingContext,
    candidates: Candidate[],
    inputs: RankingInputs,
  ): { kept: Candidate[]; dropped: Array<{ postId: string; reason: string }> };
}

/**
 * The scoring stage. The seam a learned ranker would implement.
 *
 * Phase 1's implementations are deterministic and configuration-driven; nothing
 * about this interface assumes that, which is the point.
 */
export interface Ranker {
  readonly surface: RecommendationSurface;
  score(ctx: RankingContext, candidates: Candidate[], inputs: RankingInputs): ScoredCandidate[];
}

export interface RerankerPort {
  rerank(ctx: RankingContext, scored: ScoredCandidate[], inputs: RankingInputs): ScoredCandidate[];
}

export interface RecommendationConfigProviderPort {
  active(): Promise<{
    config: RecommendationConfig;
    versionId: string;
    versionLabel: string;
    /** True when no active version was readable and defaults were used. */
    fallback: boolean;
  }>;
}

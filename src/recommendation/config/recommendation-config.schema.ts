import { z } from 'zod';

/**
 * The recommendation configuration schema — the single place every tunable
 * ranking parameter is declared, bounded and defaulted (plan §21).
 *
 * THIS FILE IS THE CONTRACT. Nothing in the ranker may read a magic number that
 * is not declared here: a weight, a limit, a half-life or a cap that lives in a
 * service is a value Phase 2's admin panel cannot reach and no algorithm version
 * can explain. If a new behaviour needs a knob, it is added here first.
 *
 * Every numeric field is bounded by `.min()/.max()`. The bounds are the safety
 * rail that makes "let an admin tune the weights" a safe capability: a slider
 * cannot set a weight to 10,000, cannot disable diversity entirely, and cannot
 * push exploration to 100% of the feed. Validation is therefore a security
 * control, not an ergonomic nicety.
 *
 * What is deliberately NOT here:
 *   * Anything that decides ELIGIBILITY. Deletion, blocking, privacy,
 *     moderation and restriction are computed from the product's own tables and
 *     enforced by RLS. There is no config value that can widen them, because
 *     admitting one would let a ranking knob change who can see what.
 *   * The DEFINITION of quality. `quality_score` is computed in SQL from
 *     engagement, watch and completion. Config decides how much quality
 *     *matters* per surface; it cannot redefine what quality *is*.
 */

// ---------------------------------------------------------------- primitives

/** A ranking weight. Bounded so no single component can dwarf the others. */
const weight = () => z.number().min(0).max(5);

/** A ratio/probability in [0,1]. */
const ratio = () => z.number().min(0).max(1);

/**
 * Freshness decay.
 *
 * `halfLifeHours` is the only decay parameter: after this many hours a post's
 * freshness component is worth half of what it was. Expressed as a half-life
 * rather than a raw lambda because a half-life is a number an operator can
 * reason about ("shorts go stale in a day") while a decay constant is not.
 *
 * `floor` stops decay from reaching zero, so genuinely good older content stays
 * rankable instead of being mathematically erased.
 */
const freshnessSchema = z
  .object({
    halfLifeHours: z.number().min(0.5).max(720).default(18),
    floor: ratio().default(0.05),
    /** Content newer than this is treated as maximally fresh (no penalty yet). */
    graceMinutes: z.number().min(0).max(1440).default(15),
  })
  .strict();

/**
 * Diversity / re-ranking limits, applied in a sliding window over the final
 * ordering.
 *
 * Minimums are 1, never 0: a limit of 0 would mean "no posts from this author
 * anywhere", which is a suppression mechanism masquerading as a diversity knob.
 */
const diversitySchema = z
  .object({
    /** Max posts by one author within `windowSize` consecutive results. */
    maxPerAuthor: z.number().int().min(1).max(10).default(2),
    /** Max posts for one game/topic within the window. */
    maxPerGame: z.number().int().min(1).max(20).default(4),
    /** Max posts of one content type within the window. */
    maxPerContentType: z.number().int().min(1).max(20).default(5),
    /** The sliding window the three limits above are measured over. */
    windowSize: z.number().int().min(2).max(50).default(10),
    /**
     * How strongly an already-seen item is demoted, per prior exposure.
     * A multiplier, not an exclusion: something seen once and ignored should
     * sink, but a post seen once is not permanently unshowable.
     */
    repetitionPenalty: ratio().default(0.45),
    /** Exposures at or above this count are dropped from the slate entirely. */
    maxExposuresBeforeDrop: z.number().int().min(1).max(20).default(3),
    /** How far back exposures are considered for repetition control. */
    exposureWindowHours: z.number().int().min(1).max(720).default(72),
  })
  .strict();

/**
 * Exploration: reserved slots for content the exploitative ranker would not
 * choose. Capped at 40% — beyond that the feed stops being personalised at all,
 * which is a product change, not a tuning decision.
 *
 * Exploration selects from candidates that already passed eligibility AND meet
 * `minQuality`, so it can never become a channel for random or low-grade
 * content.
 */
const explorationSchema = z
  .object({
    ratio: z.number().min(0).max(0.4).default(0.15),
    /** Quality floor an exploration pick must still clear. */
    minQuality: ratio().default(0.05),
    /** Extra exploration allowance for a viewer with no interest signal yet. */
    coldStartRatio: z.number().min(0).max(0.8).default(0.4),
    /** Impressions below which content counts as "new" for exploration. */
    newContentMaxImpressions: z.number().int().min(0).max(10_000).default(50),
  })
  .strict();

/** Candidate pool sizing. Bounded above so one request cannot scan the table. */
const candidateLimitsSchema = z
  .object({
    perSource: z.number().int().min(5).max(200).default(60),
    total: z.number().int().min(10).max(1000).default(400),
    /** How recent "recent" is for the freshness candidate source. */
    freshHours: z.number().int().min(1).max(2160).default(72),
  })
  .strict();

// ------------------------------------------------------------ surface weights

/**
 * Feed ranking weights. Each is a contribution to a normalised [0,1] score, so
 * they are comparable and the relative sizes are the actual tuning surface.
 *
 * `interest` and `identityAffinity` are separate on purpose (§ identity-centric
 * model): "this is about a game you care about" and "this is by someone you care
 * about" are different reasons, and collapsing them into one number would make
 * both unexplainable.
 */
const feedWeightsSchema = z
  .object({
    interest: weight().default(1.0),
    identityAffinity: weight().default(1.2),
    social: weight().default(0.8),
    quality: weight().default(1.0),
    engagement: weight().default(0.6),
    watch: weight().default(0.5),
    freshness: weight().default(1.1),
    popularity: weight().default(0.4),
    /**
     * Own content (§45). Below 1.0 by default: a user's own posts belong in
     * their feed but must not dominate it. Capped at 1.5 so this can never
     * become an auto-#1 placement.
     */
    ownContent: z.number().min(0).max(1.5).default(0.6),
    negativeFeedback: weight().default(1.0),
  })
  .strict();

/**
 * Shorts weights. The objective is expected meaningful watch, not views:
 * `watchProbability × expectedDuration` is the core term, so completion and
 * average watch duration carry more than raw popularity.
 */
const shortsWeightsSchema = z
  .object({
    watchProbability: weight().default(1.4),
    expectedWatch: weight().default(1.3),
    completion: weight().default(1.0),
    interest: weight().default(0.9),
    identityAffinity: weight().default(1.0),
    quality: weight().default(0.8),
    freshness: weight().default(0.9),
    popularity: weight().default(0.3),
    ownContent: z.number().min(0).max(1.5).default(0.4),
    negativeFeedback: weight().default(1.2),
  })
  .strict();

/**
 * Search weights.
 *
 * `relevance` has a MINIMUM of 1.0 while every personalisation weight is capped
 * at 0.5. That asymmetry is the schema enforcing the product rule (§12): search
 * is query-driven, and no combination of affinity and popularity can outrank a
 * strong lexical match. It is a bound rather than a convention precisely so a
 * future admin cannot turn search into a recommendation feed with a slider.
 */
const searchWeightsSchema = z
  .object({
    relevance: z.number().min(1).max(5).default(3.0),
    identityAffinity: z.number().min(0).max(0.5).default(0.25),
    quality: z.number().min(0).max(0.5).default(0.2),
    popularity: z.number().min(0).max(0.5).default(0.15),
    freshness: z.number().min(0).max(0.5).default(0.1),
  })
  .strict();

// ----------------------------------------------------------- shared behaviour

/**
 * Signal weights for the user-interest model. Mirrored into the SQL rebuild via
 * `reco_rebuild_user_features(p_signal_weights)`, so retuning them from the
 * admin panel changes the interest model without a deploy — and the change is
 * attributable to a config version.
 *
 * The ordering (view < watch < reaction < share/follow) is a product judgement,
 * not arithmetic: a share is a much stronger statement of interest than a view.
 * Negative signals are negative numbers in the same space, which is what lets
 * one table express both interest and disinterest.
 */
const signalWeightsSchema = z
  .object({
    impression: z.number().min(0).max(10).default(0.1),
    view: z.number().min(0).max(10).default(0.5),
    open: z.number().min(0).max(10).default(1.0),
    watchProgress: z.number().min(0).max(10).default(1.0),
    watchMilestone: z.number().min(0).max(10).default(2.0),
    complete: z.number().min(0).max(10).default(3.0),
    reaction: z.number().min(0).max(10).default(3.0),
    comment: z.number().min(0).max(10).default(4.0),
    save: z.number().min(0).max(10).default(4.0),
    share: z.number().min(0).max(10).default(5.0),
    follow: z.number().min(0).max(10).default(6.0),
    profileView: z.number().min(0).max(10).default(1.0),
    searchClick: z.number().min(0).max(10).default(1.5),
    /** Negative by construction — the bound prevents an accidental positive. */
    unfollow: z.number().min(-10).max(0).default(-4.0),
    skip: z.number().min(-10).max(0).default(-0.5),
  })
  .strict();

const decaySchema = z
  .object({
    /**
     * Interest half-life. 14 days means today's burst raises an affinity
     * without erasing a long-standing one, and a months-old event cannot
     * dominate the present.
     */
    interestHalfLifeDays: z.number().min(0.5).max(365).default(14),
    /** How far back the interest model reads events. */
    lookbackDays: z.number().int().min(1).max(730).default(90),
  })
  .strict();

const coldStartSchema = z
  .object({
    /** Interactions below which a viewer is treated as cold-start. */
    interactionThreshold: z.number().int().min(0).max(1000).default(10),
    /** Weight given to declared (onboarding) games before behaviour exists. */
    declaredInterestWeight: weight().default(1.5),
    /** Share of a cold-start slate that may come from popular/trending. */
    popularContentRatio: ratio().default(0.5),
  })
  .strict();

const safetySchema = z
  .object({
    /**
     * A candidate scoring below this is dropped rather than shown as filler.
     * 0 by default: with a small catalogue, filtering on absolute score would
     * empty the feed. It exists so a mature catalogue can raise the floor.
     */
    minScore: ratio().default(0),
    /** Negative-feedback rate above which content is excluded from ranking. */
    maxNegativeRate: ratio().default(0.5),
    /**
     * The band a manual intervention multiplier is clamped to AFTER stacking.
     * The DB constrains each row; this clamps the composed product, so several
     * live boosts still cannot exceed the ceiling.
     */
    interventionMin: z.number().min(0.1).max(1).default(0.25),
    interventionMax: z.number().min(1).max(5).default(3),
  })
  .strict();

// --------------------------------------------------------------- surface roots

const feedSurfaceSchema = z
  .object({
    /**
     * The rollout switch. False returns the surface to pure chronological
     * ordering — an operational lever that needs no deploy, which is what makes
     * shipping ranking ON by default a reversible decision.
     */
    enabled: z.boolean().default(true),
    weights: feedWeightsSchema.default({}),
    freshness: freshnessSchema.default({}),
    diversity: diversitySchema.default({}),
    exploration: explorationSchema.default({}),
    candidateLimits: candidateLimitsSchema.default({}),
  })
  .strict();

const shortsSurfaceSchema = z
  .object({
    enabled: z.boolean().default(true),
    weights: shortsWeightsSchema.default({}),
    // Shorts go stale faster than feed posts, so the default half-life is
    // shorter. Same schema, different default — surfaces tune independently.
    freshness: freshnessSchema.default({ halfLifeHours: 12, floor: 0.05, graceMinutes: 15 }),
    diversity: diversitySchema.default({
      maxPerAuthor: 2,
      maxPerGame: 5,
      maxPerContentType: 20,
      windowSize: 8,
      repetitionPenalty: 0.6,
      maxExposuresBeforeDrop: 2,
      exposureWindowHours: 48,
    }),
    exploration: explorationSchema.default({}),
    candidateLimits: candidateLimitsSchema.default({}),
  })
  .strict();

const searchSurfaceSchema = z
  .object({
    enabled: z.boolean().default(true),
    weights: searchWeightsSchema.default({}),
    freshness: freshnessSchema.default({ halfLifeHours: 336, floor: 0.2, graceMinutes: 15 }),
    candidateLimits: candidateLimitsSchema.default({}),
  })
  .strict();

const sharedSchema = z
  .object({
    signalWeights: signalWeightsSchema.default({}),
    decay: decaySchema.default({}),
    coldStart: coldStartSchema.default({}),
    safety: safetySchema.default({}),
    /**
     * How long a resolved config is cached in process. Short, because config
     * activation must take effect quickly across serverless instances without a
     * cross-instance invalidation channel.
     */
    configCacheSeconds: z.number().int().min(0).max(3600).default(60),
    /** Fraction of ranking requests that emit verbose debug logs. */
    debugLogSampleRate: ratio().default(0.01),
  })
  .strict();

export const recommendationConfigSchema = z
  .object({
    feed: feedSurfaceSchema.default({}),
    shorts: shortsSurfaceSchema.default({}),
    search: searchSurfaceSchema.default({}),
    shared: sharedSchema.default({}),
  })
  .strict();

// ---------------------------------------------------------------------- types

export type RecommendationConfig = z.infer<typeof recommendationConfigSchema>;
export type FeedSurfaceConfig = z.infer<typeof feedSurfaceSchema>;
export type ShortsSurfaceConfig = z.infer<typeof shortsSurfaceSchema>;
export type SearchSurfaceConfig = z.infer<typeof searchSurfaceSchema>;
export type FreshnessConfig = z.infer<typeof freshnessSchema>;
export type DiversityConfig = z.infer<typeof diversitySchema>;
export type ExplorationConfig = z.infer<typeof explorationSchema>;
export type CandidateLimitsConfig = z.infer<typeof candidateLimitsSchema>;
export type SignalWeights = z.infer<typeof signalWeightsSchema>;
export type SharedConfig = z.infer<typeof sharedSchema>;
export type FeedWeights = z.infer<typeof feedWeightsSchema>;
export type ShortsWeights = z.infer<typeof shortsWeightsSchema>;
export type SearchWeights = z.infer<typeof searchWeightsSchema>;

/** The three ranking surfaces. Matches `reco_surfaces.id` in the database. */
export const RECOMMENDATION_SURFACES = ['feed', 'shorts', 'search'] as const;
export type RecommendationSurface = (typeof RECOMMENDATION_SURFACES)[number];

/**
 * The safe defaults, materialised by parsing an empty object. Deriving them from
 * the schema rather than writing a second literal means the defaults can never
 * drift from the bounds that validate them — and guarantees the fallback config
 * is itself valid.
 */
export const DEFAULT_RECOMMENDATION_CONFIG: RecommendationConfig =
  recommendationConfigSchema.parse({});

export interface ConfigValidationIssue {
  path: string;
  message: string;
}

export interface ConfigValidationResult {
  valid: boolean;
  config?: RecommendationConfig;
  issues: ConfigValidationIssue[];
}

/**
 * Validates an untrusted config document (an admin draft, or a stored row).
 * Returns the parsed config with defaults applied, or every issue found —
 * plural, because an admin fixing one field at a time through a form is a worse
 * experience than seeing all of them at once.
 */
export function validateRecommendationConfig(input: unknown): ConfigValidationResult {
  const result = recommendationConfigSchema.safeParse(input);
  if (result.success) {
    return { valid: true, config: result.data, issues: [] };
  }
  return {
    valid: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.join('.') || '(root)',
      message: issue.message,
    })),
  };
}

/**
 * The signal weights in the snake_case shape
 * `reco_rebuild_user_features(p_signal_weights)` expects.
 *
 * The SQL function carries its own copy of these defaults so a bare call is
 * meaningful, but the ACTIVE config is what the scheduled rebuild passes — this
 * mapper is the seam between the two naming conventions, kept in one place so a
 * renamed key fails here rather than silently zeroing a signal in SQL.
 */
export function signalWeightsForSql(weights: SignalWeights): Record<string, number> {
  return {
    impression: weights.impression,
    view: weights.view,
    open: weights.open,
    watch_progress: weights.watchProgress,
    watch_milestone: weights.watchMilestone,
    complete: weights.complete,
    reaction: weights.reaction,
    comment: weights.comment,
    save: weights.save,
    share: weights.share,
    follow: weights.follow,
    profile_view: weights.profileView,
    search_click: weights.searchClick,
    unfollow: weights.unfollow,
    skip: weights.skip,
  };
}

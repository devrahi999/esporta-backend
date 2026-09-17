import type { RecommendationSurface } from '../config/recommendation-config.schema';
import {
  clamp,
  expectedWatchValue,
  freshnessScore,
  logNormalise,
  shrinkToPrior,
  signedAffinityToScore,
  stableUnitInterval,
  weightedScore,
} from './scoring';
import type {
  AuthorAffinity,
  AuthorFeatures,
  Candidate,
  ContentFeatures,
  RankingContext,
  RankingInputs,
  Ranker,
  ScoreExplanation,
  ScoredCandidate,
  ViewerFeatures,
} from './types';

/**
 * The three surface rankers.
 *
 * They share the feature layer, the eligibility layer, the config framework, the
 * scoring primitives, the explanation shape and the re-ranker — and differ only
 * in their OBJECTIVE, which is what §2 asks for ("do NOT create three unrelated
 * algorithms" but "allow different ranking formulas"). Everything genuinely
 * common lives in {@link BaseRanker}; each subclass contributes only the
 * component vector its objective calls for.
 *
 * No `Math.random`, no `Date.now()`: `ctx.nowMs` and `ctx.timeBucket` are
 * injected, so any ranking is reproducible from its inputs (§35).
 */

/** Reference scale for normalising watch duration. 60s ≈ a fully-watched short. */
const WATCH_REFERENCE_MS = 60_000;

/**
 * The prior an unproven item's quality is shrunk toward.
 *
 * Deliberately mid-low: new content should not be assumed good (that is how a
 * feed fills with untested content), nor assumed bad (that is how nothing new
 * ever surfaces). 0.35 lets a cold-start item compete on freshness and affinity
 * while quality stays agnostic until evidence arrives.
 */
const COLD_START_QUALITY_PRIOR = 0.35;

/**
 * The neutral point of {@link signedAffinityToScore} — the value a 0-affinity
 * relationship maps to. {@link affinityScore} subtracts it so that absent
 * affinity (0) sits exactly BETWEEN negative and positive affinity, keeping the
 * mapping strictly monotonic through zero.
 */
const AFFINITY_NEUTRAL = 0.25;

interface WeightedComponent {
  key: string;
  value: number;
  weight: number;
}

/** The per-candidate context a component vector is built from. */
interface CandidateContext {
  viewer: ViewerFeatures | null;
  affinity: AuthorAffinity | undefined;
  author: AuthorFeatures | undefined;
  topics: Record<string, number>;
  isOwn: boolean;
}

abstract class BaseRanker implements Ranker {
  abstract readonly surface: RecommendationSurface;

  score(ctx: RankingContext, candidates: Candidate[], inputs: RankingInputs): ScoredCandidate[] {
    const out: ScoredCandidate[] = [];
    for (const candidate of candidates) {
      const content = inputs.content[candidate.postId];
      // A candidate with no feature row cannot be scored. It is skipped rather
      // than scored at zero: zero is a judgement ("bad content"), absence is a
      // pipeline state ("features not computed yet"), and conflating them would
      // permanently bury anything the rebuild has not reached.
      if (!content) continue;
      out.push(this.scoreOne(ctx, candidate, content, inputs));
    }
    return out;
  }

  private scoreOne(
    ctx: RankingContext,
    candidate: Candidate,
    content: ContentFeatures,
    inputs: RankingInputs,
  ): ScoredCandidate {
    const candidateCtx: CandidateContext = {
      viewer: inputs.viewer,
      affinity: inputs.authorAffinity[content.authorId],
      author: inputs.authorFeatures[content.authorId],
      topics: inputs.viewerTopics,
      isOwn: content.authorId === ctx.viewerId,
    };

    const components = this.components(ctx, content, candidateCtx);
    const { score: organic } = weightedScore(components);

    const penalties = this.penalties(ctx, candidate, content, inputs);
    const penaltyMultiplier = Object.values(penalties).reduce(
      (acc, penalty) => acc * (1 - clamp(penalty)),
      1,
    );

    // Manual interventions apply LAST and multiplicatively, and the organic
    // score is preserved separately in the explanation (§25): an intervention
    // adjusts what is shown without mutating the measured judgement, so
    // revoking it restores the original ranking exactly.
    const interventionMultiplier = this.interventionFor(
      ctx,
      candidate.postId,
      content.authorId,
      inputs,
    );

    // The viewer's temporary admin-set control (Phase 2) — same multiplicative
    // channel as interventions, so it composes with them inside the SAME clamp
    // band and can never out-power policy. Keyed on the candidate's topics.
    const controlMultiplier = this.viewerControlFor(ctx, content, inputs);

    const total = clamp(organic * penaltyMultiplier * interventionMultiplier * controlMultiplier);

    const explanation: ScoreExplanation = {
      total: round(total),
      organic: round(organic),
      components: Object.fromEntries(
        components.filter((c) => c.weight > 0).map((c) => [c.key, round(c.value)]),
      ),
      penalties: Object.fromEntries(
        Object.entries(penalties)
          .filter(([, v]) => v > 0)
          .map(([k, v]) => [k, round(v)]),
      ),
      interventionMultiplier: round(interventionMultiplier),
      viewerControlMultiplier: controlMultiplier !== 1 ? round(controlMultiplier) : undefined,
      exploration: false,
      source: candidate.source,
    };

    return {
      postId: candidate.postId,
      authorId: content.authorId,
      score: total,
      explanation,
      gameId: content.gameId,
      typeId: content.typeId,
      createdAtMs: content.createdAtMs,
    };
  }

  /** The surface's objective, as a weighted component vector. */
  protected abstract components(
    ctx: RankingContext,
    content: ContentFeatures,
    candidateCtx: CandidateContext,
  ): WeightedComponent[];

  /**
   * Repetition penalty from the server-side exposure log (§19).
   *
   * Server-side because the client cannot be the source of truth here: a refresh,
   * an app restart or a second device would each forget what was shown, and the
   * same item would be re-served as if new.
   */
  protected penalties(
    ctx: RankingContext,
    candidate: Candidate,
    content: ContentFeatures,
    inputs: RankingInputs,
  ): Record<string, number> {
    const penalties: Record<string, number> = {};
    const diversity =
      ctx.surface === 'shorts' ? ctx.config.shorts.diversity : ctx.config.feed.diversity;
    const exposure = inputs.exposures[candidate.postId];

    if (exposure && exposure.shown > 0) {
      // Compounding, so a third showing is penalised harder than a second.
      // Capped below 1 so repetition can never zero a score outright — dropping
      // is the exposure-count rule's job, not the penalty's.
      penalties.repetition = clamp(
        1 - Math.pow(1 - diversity.repetitionPenalty, exposure.shown),
        0,
        0.95,
      );
    }

    if (content.negativeRate > 0) {
      penalties.negativeFeedback = clamp(content.negativeRate);
    }

    return penalties;
  }

  /**
   * The composed intervention multiplier for a post, clamped to the configured
   * band.
   *
   * Post- and identity-scoped interventions multiply together, then the product
   * is clamped — so stacking a post boost on an author boost still cannot exceed
   * the ceiling. The DB constrains each row; this constrains their composition.
   */
  protected interventionFor(
    ctx: RankingContext,
    postId: string,
    authorId: string,
    inputs: RankingInputs,
  ): number {
    const post = inputs.interventions[`post:${postId}`] ?? 1;
    const identity = inputs.interventions[`identity:${authorId}`] ?? 1;
    const { interventionMin, interventionMax } = ctx.config.shared.safety;
    return clamp(post * identity, interventionMin, interventionMax);
  }

  /**
   * The viewer-control multiplier for one candidate, composed from the
   * candidate's own topic keys (game / content type / author identity).
   *
   * Multiple matching keys multiply, then clamp to the SAME intervention band
   * as {@link interventionFor} — a viewer control is deliberately incapable of
   * exceeding what a global intervention may do, no matter how many keys the
   * admin combines. Returns 1 (no effect) when the viewer has no active
   * controls, which is the overwhelmingly common case.
   */
  protected viewerControlFor(
    ctx: RankingContext,
    content: ContentFeatures,
    inputs: RankingInputs,
  ): number {
    const multipliers = inputs.viewerControls.multipliers;
    if (Object.keys(multipliers).length === 0) return 1;

    let composed = 1;
    if (content.gameId) {
      composed *= multipliers[`game:${content.gameId}`] ?? 1;
    }
    composed *= multipliers[`content_type:${content.typeId}`] ?? 1;
    composed *= multipliers[`identity:${content.authorId}`] ?? 1;
    if (composed === 1) return 1;

    const { interventionMin, interventionMax } = ctx.config.shared.safety;
    return clamp(composed, interventionMin, interventionMax);
  }

  // ------------------------------------------------------------ shared signals

  /**
   * Interest match: how much this viewer's affinity covers the item's game.
   *
   * Falls back to declared (onboarding) games when behavioural affinity is
   * absent, which is what carries a brand-new account's first feed (§16).
   * Untagged content gets a neutral 0.5 rather than 0 — "we don't know this
   * post's game" is not evidence the viewer dislikes it, and scoring it 0 would
   * bury the entire untagged catalogue.
   */
  protected interestScore(
    ctx: RankingContext,
    content: ContentFeatures,
    candidateCtx: CandidateContext,
  ): number {
    if (!content.gameId) return 0.5;

    const behavioural = candidateCtx.topics[`game:${content.gameId}`] ?? 0;
    if (behavioural > 0) return clamp(behavioural);

    if (candidateCtx.viewer?.declaredGameIds.includes(content.gameId)) {
      // Declared interest is a real signal but a weaker one than demonstrated
      // behaviour, so it is scaled by the configured weight and capped.
      return clamp(ctx.config.shared.coldStart.declaredInterestWeight / 2);
    }
    return 0;
  }

  /** Viewer → author affinity, signed so a disliked author is demoted. */
  protected affinityScore(affinity: AuthorAffinity | undefined): number {
    // Absent affinity and negative affinity must NOT land on the same value:
    // signedAffinityToScore maps both to [0, neutral], so a naive pass-through
    // ranked a disliked author ABOVE a stranger (0.05 vs 0). Subtracting the
    // neutral point makes the mapping strictly monotonic through zero —
    // negative demotes below absent, positive promotes above it.
    if (!affinity) return 0;
    return signedAffinityToScore(affinity.score) - AFFINITY_NEUTRAL;
  }

  /** The social signal, kept separate from affinity: a follow is a fact. */
  protected socialScore(affinity: AuthorAffinity | undefined): number {
    if (!affinity) return 0;
    if (affinity.follows) return 1;
    // A negative affinity suppresses the incidental-social credit too —
    // otherwise past interactions kept paying a disliked author a social bonus
    // through the back door.
    if (affinity.score < 0) return 0;
    return affinity.interactions > 0 ? 0.5 : 0;
  }

  /**
   * Content quality, shrunk toward a prior by observation confidence.
   *
   * This is the cold-start guard: a post with two impressions does not win or
   * lose on a statistically meaningless rate.
   */
  protected qualityScore(content: ContentFeatures, author: AuthorFeatures | undefined): number {
    const prior = author
      ? clamp(author.quality * 0.7 + COLD_START_QUALITY_PRIOR * 0.3)
      : COLD_START_QUALITY_PRIOR;
    return shrinkToPrior(content.quality, content.confidence, prior);
  }

  protected freshness(ctx: RankingContext, content: ContentFeatures): number {
    const cfg =
      ctx.surface === 'feed'
        ? ctx.config.feed.freshness
        : ctx.surface === 'shorts'
          ? ctx.config.shorts.freshness
          : ctx.config.search.freshness;
    return freshnessScore(
      content.createdAtMs,
      ctx.nowMs,
      cfg.halfLifeHours,
      cfg.floor,
      cfg.graceMinutes,
    );
  }

  /** Popularity, log-compressed upstream in SQL; re-clamped defensively. */
  protected popularityScore(content: ContentFeatures): number {
    return clamp(content.popularity);
  }
}

/**
 * Feed ranker (§10).
 *
 * Interest, identity affinity and social relevance are three separate
 * components, not one "relevance" number, so a bad feed can be diagnosed to the
 * signal that misfired.
 */
export class FeedRanker extends BaseRanker {
  readonly surface = 'feed' as const;

  protected components(
    ctx: RankingContext,
    content: ContentFeatures,
    candidateCtx: CandidateContext,
  ): WeightedComponent[] {
    const w = ctx.config.feed.weights;

    // §45: own content is eligible and ranked, never auto-promoted. Its
    // affinity and social components are replaced by a single bounded
    // `ownContent` weight — self-affinity is not a meaningful signal (the
    // feature layer never records it), and letting a user's own posts collect
    // affinity credit is how a feed becomes a mirror.
    const affinityComponent: WeightedComponent = candidateCtx.isOwn
      ? { key: 'ownContent', value: 1, weight: w.ownContent }
      : {
          key: 'identityAffinity',
          value: this.affinityScore(candidateCtx.affinity),
          weight: w.identityAffinity,
        };

    const socialComponent: WeightedComponent = candidateCtx.isOwn
      ? { key: 'social', value: 0, weight: 0 }
      : { key: 'social', value: this.socialScore(candidateCtx.affinity), weight: w.social };

    return [
      { key: 'interest', value: this.interestScore(ctx, content, candidateCtx), weight: w.interest },
      affinityComponent,
      socialComponent,
      { key: 'quality', value: this.qualityScore(content, candidateCtx.author), weight: w.quality },
      { key: 'engagement', value: clamp(content.engagementRate), weight: w.engagement },
      {
        key: 'watch',
        // Only video content can earn a watch contribution; a text post scoring
        // 0 here would be penalised for a signal it cannot have, so its weight
        // is dropped to 0 instead.
        value: content.hasVideo ? logNormalise(content.avgWatchMs, WATCH_REFERENCE_MS) : 0,
        weight: content.hasVideo ? w.watch : 0,
      },
      { key: 'freshness', value: this.freshness(ctx, content), weight: w.freshness },
      { key: 'popularity', value: this.popularityScore(content), weight: w.popularity },
    ];
  }
}

/**
 * Shorts ranker (§11).
 *
 * The objective is expected meaningful watch, not views. `watchProbability` is
 * derived from the item's own retention behaviour and the viewer's watch
 * tendency, then multiplied by expected duration — a product, so a clip nobody
 * starts and a clip everyone abandons both score low.
 */
export class ShortsRanker extends BaseRanker {
  readonly surface = 'shorts' as const;

  protected components(
    ctx: RankingContext,
    content: ContentFeatures,
    candidateCtx: CandidateContext,
  ): WeightedComponent[] {
    const w = ctx.config.shorts.weights;
    const watchProbability = this.watchProbability(content, candidateCtx.viewer);

    const affinityComponent: WeightedComponent = candidateCtx.isOwn
      ? { key: 'ownContent', value: 1, weight: w.ownContent }
      : {
          key: 'identityAffinity',
          value: this.affinityScore(candidateCtx.affinity),
          weight: w.identityAffinity,
        };

    return [
      { key: 'watchProbability', value: watchProbability, weight: w.watchProbability },
      {
        key: 'expectedWatch',
        value: expectedWatchValue(
          watchProbability,
          content.avgWatchMs,
          content.completionRate,
          WATCH_REFERENCE_MS,
        ),
        weight: w.expectedWatch,
      },
      { key: 'completion', value: clamp(content.completionRate), weight: w.completion },
      { key: 'interest', value: this.interestScore(ctx, content, candidateCtx), weight: w.interest },
      affinityComponent,
      { key: 'quality', value: this.qualityScore(content, candidateCtx.author), weight: w.quality },
      { key: 'freshness', value: this.freshness(ctx, content), weight: w.freshness },
      { key: 'popularity', value: this.popularityScore(content), weight: w.popularity },
    ];
  }

  /**
   * P(this viewer meaningfully watches this clip).
   *
   * The clip's demonstrated retention (shrunk to a prior, so an unproven clip is
   * not assumed unwatchable) blended with how much this viewer watches at all.
   * A viewer with no history reads as 0.5 — neutral, not zero, because "we don't
   * know yet" must not suppress every short for a new account.
   */
  private watchProbability(content: ContentFeatures, viewer: ViewerFeatures | null): number {
    const clipRetention = shrinkToPrior(
      clamp(
        content.completionRate * 0.6 + logNormalise(content.avgWatchMs, WATCH_REFERENCE_MS) * 0.4,
      ),
      content.confidence,
      COLD_START_QUALITY_PRIOR,
    );
    const viewerWatch = viewer
      ? clamp(viewer.watchTendency * 0.7 + viewer.shortAffinity * 0.3)
      : 0.5;
    return clamp(clipRetention * 0.7 + viewerWatch * 0.3);
  }
}

/**
 * Search ranker (§12, §33).
 *
 * Relevance-dominant by construction, in two independent ways:
 *   1. the schema caps every personalisation weight at 0.5 and forces
 *      `relevance` ≥ 1.0, so relevance dominates the weighted blend;
 *   2. relevance is ALSO a multiplicative gate on the final score, so a weak
 *      lexical match cannot be rescued by affinity or popularity however they
 *      are tuned — an exact username match cannot be pushed below a weakly
 *      related but popular entity.
 *
 * Canonical Esporta URLs (`/p/`, `/s/`, `/pp/`, `/op/`) never reach here: those
 * resolve directly to one entity, upstream of ranking.
 */
export class SearchRanker extends BaseRanker {
  readonly surface = 'search' as const;

  /** Relevance per post id, from the lexical ranker (`search_post_ids`). */
  constructor(private readonly relevance: Map<string, number>) {
    super();
  }

  score(ctx: RankingContext, candidates: Candidate[], inputs: RankingInputs): ScoredCandidate[] {
    return super.score(ctx, candidates, inputs).map((item) => {
      const relevance = clamp(this.relevance.get(item.postId) ?? 0);
      const gated = clamp(item.score * relevance);
      return {
        ...item,
        score: gated,
        explanation: {
          ...item.explanation,
          total: round(gated),
          components: { ...item.explanation.components, relevanceGate: round(relevance) },
        },
      };
    });
  }

  protected components(
    ctx: RankingContext,
    content: ContentFeatures,
    candidateCtx: CandidateContext,
  ): WeightedComponent[] {
    const w = ctx.config.search.weights;

    return [
      // Relevance is not available per-candidate here (the gate in `score`
      // applies it by post id), so the blend carries a neutral 1 and relevance's
      // dominance is expressed by the gate. Keeping the weight in the vector
      // preserves the invariant that every configured weight is used.
      { key: 'relevanceWeighted', value: 1, weight: w.relevance },
      {
        key: 'identityAffinity',
        value: this.affinityScore(candidateCtx.affinity),
        weight: w.identityAffinity,
      },
      { key: 'quality', value: this.qualityScore(content, candidateCtx.author), weight: w.quality },
      { key: 'popularity', value: this.popularityScore(content), weight: w.popularity },
      { key: 'freshness', value: this.freshness(ctx, content), weight: w.freshness },
    ];
  }

  /**
   * Search applies no repetition penalty: someone searching for a thing wants
   * the thing, even if they saw it an hour ago. Negative feedback still applies —
   * a reported post should not be a top result.
   */
  protected penalties(
    _ctx: RankingContext,
    _candidate: Candidate,
    content: ContentFeatures,
  ): Record<string, number> {
    return content.negativeRate > 0 ? { negativeFeedback: clamp(content.negativeRate) } : {};
  }
}

/**
 * Deterministic exploration (§15).
 *
 * Reserves a bounded share of the slate for items the exploitative ordering
 * would not have surfaced, selected by a STABLE HASH rather than randomness — so
 * page 2 of a session is reproducible and the Phase 2 debugger can explain why an
 * item was promoted.
 *
 * Exploration picks come only from candidates that already passed eligibility AND
 * clear `minQuality`, so this can never become a channel for unsafe or junk
 * content. The result is re-sorted by score, so an exploration pick is promoted
 * into the slate rather than teleported to position 1.
 */
export function applyExploration(
  ctx: RankingContext,
  scored: ScoredCandidate[],
  targetCount: number,
  isColdStart: boolean,
  inputs?: RankingInputs,
): ScoredCandidate[] {
  const exploration =
    ctx.surface === 'feed'
      ? ctx.config.feed.exploration
      : ctx.surface === 'shorts'
        ? ctx.config.shorts.exploration
        : null;
  if (!exploration || scored.length === 0) return scored;

  let ratio = isColdStart ? exploration.coldStartRatio : exploration.ratio;

  // A viewer-control exploration preference (Phase 2) scales the configured
  // ratio within its schema bounds — 'high' doubles it (still ≤ the 0.4 cap on
  // normal viewers, ≤ 0.8 for cold-start), 'low' halves it. The control can
  // modulate the dial but never move it past what the active config allows.
  const preference = inputs?.viewerControls.exploration;
  if (preference === 'high') ratio = Math.min(ratio * 2, isColdStart ? 0.8 : 0.4);
  if (preference === 'low') ratio = ratio / 2;

  const slots = Math.floor(targetCount * clamp(ratio, 0, 0.8));
  if (slots <= 0) return scored;

  const ranked = [...scored].sort((a, b) => b.score - a.score);
  const head = ranked.slice(0, Math.max(0, targetCount - slots));
  const chosen = new Set(head.map((item) => item.postId));

  // The tail is everything the exploitative ordering left out. Ordered by a
  // stable hash, so the choice is arbitrary-but-reproducible rather than
  // score-ordered — score order would just re-pick the next-best items and
  // explore nothing.
  const explored = ranked
    .filter((item) => !chosen.has(item.postId) && item.score >= exploration.minQuality)
    .map((item) => ({
      item,
      key: stableUnitInterval(ctx.viewerId, item.postId, ctx.configVersionId, ctx.timeBucket),
    }))
    .sort((a, b) => a.key - b.key)
    .slice(0, slots)
    .map(({ item }) => ({
      ...item,
      explanation: { ...item.explanation, exploration: true },
    }));

  return [...head, ...explored].sort((a, b) => b.score - a.score);
}

function round(value: number): number {
  return Math.round(value * 100_000) / 100_000;
}

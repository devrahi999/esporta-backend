import { clamp, shrinkToPrior, signedAffinityToScore, weightedScore } from './scoring';
import type {
  AuthorAffinity,
  IdentitySearchInputs,
  SearchIdentityFeatures,
} from './types';
import type { RankingContext, ScoreExplanation } from './types';

/**
 * Identity search ranking — profiles (personal identities) and teams, the two
 * IDENTITY search surfaces the Phase 1 finalization adds.
 *
 * PHILOSOPHY: IDENTICAL to post search, by construction rather than by copy.
 * The lexical layer (`search_identity_ids`) decides WHICH identities match and
 * how relevant each is; this ranker only re-orders that result set within the
 * bounded personalisation the schema allows. Both personal and team search run
 * through this ONE class — a team is an identity with `kind='team'`, and the
 * identity-centric model is what makes that the correct abstraction rather than
 * a shortcut: the same affinity table, the same feature table and the same
 * config weights apply to both, so there is no separate team-ranking subsystem
 * to drift.
 *
 * RELEVANCE DOMINANCE is enforced the same two ways as in post search:
 *   1. the schema caps every personalisation weight at 0.5 and forces
 *      `relevance` ≥ 1.0, so relevance dominates the weighted blend;
 *   2. relevance is ALSO a multiplicative gate — score × relevance — so an
 *      exact username match cannot be buried by popularity or affinity however
 *      they are tuned.
 *
 * The two bounded components that can reorder WITHIN a relevance tier:
 *   * `identityAffinity` — the viewer's signed affinity for that identity,
 *     from the same centralized model Feed and Shorts use;
 *   * `entityQuality` — shrunk-to-prior identity quality/activity, plus
 *     popularity, exactly the signals the schema names for search.
 *
 * Nothing is generated: no candidates, no exploration, no diversity re-rank.
 * Search is query-driven; a smaller, correctly-ordered result set is correct.
 */

/** The prior an identity's quality is shrunk toward when its evidence is thin. */
const IDENTITY_QUALITY_PRIOR = 0.35;

/**
 * The neutral point of {@link signedAffinityToScore} — what a 0-affinity
 * relationship maps to. Subtracting it makes absent affinity (0) sit exactly
 * between negative and positive affinity, keeping the mapping strictly
 * monotonic through zero.
 */
const AFFINITY_NEUTRAL = 0.25;

export interface ScoredIdentity {
  identityId: string;
  score: number;
  explanation: ScoreExplanation;
}

export class IdentitySearchRanker {
  /** Lexical relevance per identity id, from `search_identity_ids`. */
  constructor(private readonly relevance: Map<string, number>) {}

  score(
    ctx: RankingContext,
    identityIds: string[],
    inputs: IdentitySearchInputs,
  ): ScoredIdentity[] {
    const out: ScoredIdentity[] = [];

    for (const identityId of identityIds) {
      const features = inputs.identities[identityId];
      // No feature row (rebuild has not reached this identity) → skip rather
      // than score at zero: zero is a judgement, absence is a pipeline state,
      // and conflating them would permanently bury identities the nightly job
      // has not touched. The lexical order still serves them via the fallback.
      if (!features) continue;

      // Hard eligibility inside the ranked path: a restricted identity is
      // status='active' so RLS will not drop it — the ranker must.
      if (features.restricted) continue;

      const affinity = inputs.affinity[identityId];
      const components = this.components(ctx, features, affinity);

      const { score: organic } = weightedScore(components);

      // The composed manual-intervention multiplier, clamped to the configured
      // band — same contract as the content rankers. An intervention can reorder
      // a ranked result set; it can never make an ineligible identity appear,
      // because eligibility was decided above and at the lexical/RLS layers.
      const raw = inputs.interventions[`identity:${identityId}`] ?? 1;
      const { interventionMin, interventionMax } = ctx.config.shared.safety;
      const interventionMultiplier = clamp(raw, interventionMin, interventionMax);

      // The relevance GATE. Multiplicative, so relevance 0 → score 0, and an
      // exact match's dominance cannot be diluted by the bounded components.
      const relevance = clamp(this.relevance.get(identityId) ?? 0);
      const total = clamp(organic * interventionMultiplier * relevance);

      out.push({
        identityId,
        score: total,
        explanation: {
          total: round(total),
          organic: round(organic),
          components: {
            relevanceGate: round(relevance),
            ...Object.fromEntries(
              components
                .filter((c) => c.weight > 0)
                .map((c) => [c.key, round(c.value)]),
            ),
          },
          penalties: {},
          interventionMultiplier: round(interventionMultiplier),
          exploration: false,
          source: 'quality',
        },
      });
    }

    // Deterministic total ordering: score desc, then id asc (§35). The id
    // tiebreak is what makes identical requests byte-identical.
    return out.sort((a, b) => b.score - a.score || (a.identityId < b.identityId ? -1 : 1));
  }

  /**
   * The bounded component vector, straight from `search.weights` in the active
   * config — the SAME weights post search uses. One config surface, one
   * philosophy, three entity types.
   */
  private components(
    ctx: RankingContext,
    features: SearchIdentityFeatures,
    affinity: AuthorAffinity | undefined,
  ): WeightedComponent[] {
    const w = ctx.config.search.weights;

    return [
      // Relevance also enters the blend (in addition to the gate) so its weight
      // remains meaningful for near-tie ordering among gated candidates.
      { key: 'relevanceWeighted', value: 1, weight: w.relevance },
      {
        key: 'identityAffinity',
        // Re-centred on the neutral point so a NEGATIVE affinity ranks below an
        // absent one (a stranger), not between a stranger and a friend — the
        // same monotonic-through-zero contract the content rankers use.
        value: affinity ? signedAffinityToScore(affinity.score) - AFFINITY_NEUTRAL : 0,
        weight: w.identityAffinity,
      },
      {
        key: 'quality',
        // Identity quality shrunk to a prior by its own confidence: a brand-new
        // identity with two impressions neither wins nor loses on noise.
        value: shrinkToPrior(features.quality, features.confidence, IDENTITY_QUALITY_PRIOR),
        weight: w.quality,
      },
      {
        key: 'popularity',
        // Already log-compressed in SQL against a 1000-follower scale, so a
        // large org cannot dominate discovery; re-clamped defensively.
        value: clamp(features.popularity),
        weight: w.popularity,
      },
      {
        key: 'freshness',
        // Recency of the entity's own activity, not of a post: an identity that
        // posted recently is the "active" result a search should prefer within
        // a relevance tier. Half-life comes from the search surface config.
        value: this.activityFreshness(ctx, features.lastPostAtMs),
        weight: w.freshness,
      },
    ];
  }

  private activityFreshness(ctx: RankingContext, lastPostAtMs: number): number {
    if (!Number.isFinite(lastPostAtMs) || lastPostAtMs <= 0) return 0;
    const cfg = ctx.config.search.freshness;
    const ageMs = Math.max(0, ctx.nowMs - lastPostAtMs);
    const halfLifeMs = Math.max(cfg.halfLifeHours, 0.001) * 3_600_000;
    return clamp(Math.max(Math.pow(2, -(ageMs / halfLifeMs)), cfg.floor));
  }
}

interface WeightedComponent {
  key: string;
  value: number;
  weight: number;
}

function round(value: number): number {
  return Math.round(value * 100_000) / 100_000;
}

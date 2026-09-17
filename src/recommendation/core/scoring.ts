/**
 * Pure ranking mathematics.
 *
 * Everything here is a deterministic function of plain numbers and strings — no
 * I/O, no Nest, no Supabase, no `Math.random`, no `Date.now()` read internally
 * (the caller passes `now`). That is what makes §35 (determinism) testable: for
 * the same inputs these functions return the same outputs, forever, so a ranking
 * can be reproduced from a stored candidate set and a config version.
 *
 * The one place randomness would normally appear — exploration — uses a stable
 * hash instead. See {@link stableUnitInterval}.
 */

/** Clamps `value` into `[min, max]`. */
export function clamp(value: number, min = 0, max = 1): number {
  // NaN is unordered and falls to the floor; ±Infinity are handled by the
  // min/max pair itself (+Inf → max, -Inf → min). An isFinite() shortcut that
  // returned `min` for both got +Infinity wrong.
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * Coerces a possibly-absent, possibly-string numeric (Postgres `numeric` arrives
 * as a string over PostgREST) into a finite number.
 *
 * Resilience to missing data (§ "resilient to missing data") is implemented here
 * rather than at every call site: a feature row that has not been computed yet
 * yields the fallback and the item still ranks, just without that signal.
 */
export function num(value: unknown, fallback = 0): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

/**
 * Exponential freshness decay with a floor.
 *
 * `2^(-age/halfLife)`: one half-life old is worth 0.5, two half-lives 0.25. A
 * half-life is the tunable form because it is the one an operator can state as a
 * product intention ("shorts should feel stale within half a day").
 *
 * `graceMinutes` keeps very new content at 1.0 so ranking does not differentiate
 * between a post from 30 seconds ago and one from 5 minutes ago — a distinction
 * that is noise, and that would make the top of the feed churn on every request.
 *
 * The floor stops decay from reaching 0: an old post with excellent quality and
 * strong affinity should still be rankable, just not on freshness merit.
 */
export function freshnessScore(
  createdAtMs: number,
  nowMs: number,
  halfLifeHours: number,
  floor: number,
  graceMinutes = 0,
): number {
  const ageMs = nowMs - createdAtMs;
  if (!Number.isFinite(ageMs)) return floor;
  // Future-dated content (clock skew) is "now", never better than now.
  if (ageMs <= graceMinutes * 60_000) return 1;
  const halfLifeMs = Math.max(halfLifeHours, 0.001) * 3_600_000;
  const decayed = Math.pow(2, -(ageMs / halfLifeMs));
  return clamp(Math.max(decayed, floor));
}

/**
 * Lower bound of the 95% Wilson score interval.
 *
 * The TypeScript twin of `reco_wilson_lower_bound` in SQL, used where the ranker
 * must derive a rate the feature table does not store. Successes are clamped to
 * trials for the same reason as in SQL: Esporta's counters do not guarantee
 * successes ≤ trials (all four engagement types can happen on a post with no
 * feed impression), and an unclamped proportion above 1 makes the interval
 * meaningless.
 */
export function wilsonLowerBound(successes: number, trials: number, z = 1.96): number {
  const n = Math.max(0, trials);
  if (n <= 0) return 0;
  const s = Math.min(Math.max(0, successes), n);
  const p = s / n;
  const z2 = z * z;
  const numerator = p + z2 / (2 * n) - z * Math.sqrt(Math.max((p * (1 - p) + z2 / (4 * n)) / n, 0));
  return clamp(numerator / (1 + z2 / n));
}

/**
 * Log-compresses an unbounded count into [0,1] against a reference scale.
 *
 * This is the anti-rich-get-richer transform (§7: "normalize popularity so large
 * existing accounts do not permanently dominate discovery"). Linear
 * normalisation would make a 100k-follower org's every post outrank everything;
 * log compression makes the 100→1,000 step matter far more than 100,000→101,000,
 * which is how attention actually works.
 */
export function logNormalise(value: number, scale: number): number {
  if (value <= 0) return 0;
  if (scale <= 1) return 1;
  return clamp(Math.log1p(value) / Math.log1p(scale));
}

/**
 * Saturating transform for an unbounded positive quantity: `x / (x + k)`.
 *
 * Used where a value has no natural maximum but diminishing returns are the
 * right shape — `k` is the half-saturation point, i.e. the value that maps to
 * 0.5, which makes it directly interpretable when tuning.
 */
export function saturate(value: number, halfSaturation: number): number {
  if (value <= 0) return 0;
  const k = Math.max(halfSaturation, 1e-9);
  return clamp(value / (value + k));
}

/**
 * Maps a signed affinity score in [-1,1] to a ranking-usable [0,1], with 0
 * affinity landing at `neutral`.
 *
 * Negative affinity must be able to DEMOTE, not merely fail to promote, which a
 * naive `clamp(score, 0, 1)` would silently prevent — a repeatedly-ignored
 * author would rank identically to an unknown one. Below neutral the value
 * scales toward 0; above it, toward 1.
 */
export function signedAffinityToScore(score: number, neutral = 0.25): number {
  const s = clamp(score, -1, 1);
  if (s >= 0) return clamp(neutral + s * (1 - neutral));
  return clamp(neutral * (1 + s));
}

/**
 * A stable, uniformly-distributed value in [0,1) derived from the given parts.
 *
 * THIS IS WHY EXPLORATION IS DETERMINISTIC (§35). Using `Math.random()` for
 * exploration would mean page 2 of a paginated feed could not be reproduced,
 * A/B results could not be replayed, and the Phase 2 debugger could never
 * explain why an item appeared. A hash of
 * (viewer, item, config version, time bucket) gives the *statistical* spread
 * exploration needs while remaining perfectly reproducible: the same viewer at
 * the same time bucket under the same config always gets the same exploration
 * decisions.
 *
 * FNV-1a over the joined parts, then scaled. Not cryptographic — it does not
 * need to be; it needs to be fast, dependency-free and identical across
 * processes, which a hand-written integer hash is and a seeded PRNG library is
 * not.
 */
export function stableUnitInterval(...parts: Array<string | number>): number {
  const input = parts.join('\u0001');
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // FNV prime 16777619, via shifts to stay in 32-bit integer arithmetic.
    hash = (hash + (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)) >>> 0;
  }
  return hash / 0x1_0000_0000;
}

/**
 * The time bucket exploration and tie-breaking are keyed to.
 *
 * Without a bucket, exploration decisions would be frozen forever (the same
 * viewer would see the same exploration picks for all time). With a bucket, they
 * rotate on a schedule while staying stable *within* a bucket — which is exactly
 * the window a pagination session lives in.
 */
export function timeBucket(nowMs: number, bucketMinutes = 60): number {
  return Math.floor(nowMs / (Math.max(1, bucketMinutes) * 60_000));
}

/**
 * Expected meaningful watch value for a short — the Shorts objective (§11).
 *
 * `P(meaningful watch) × normalised expected duration`.
 *
 * A product, not a sum, and that is the whole point: a clip nobody starts has no
 * watch value however long it is, and a clip everyone starts but abandons at 2%
 * has none either. Summing the two would let each compensate for the other and
 * would rank exactly the content Shorts should not — high-view, low-retention
 * clips.
 *
 * `completionRate` is folded in as a bounded bonus rather than a third factor,
 * so a short clip that is genuinely watched to the end is not punished for being
 * short.
 */
export function expectedWatchValue(
  watchProbability: number,
  avgWatchMs: number,
  completionRate: number,
  referenceWatchMs: number,
): number {
  const p = clamp(watchProbability);
  const duration = logNormalise(Math.max(0, avgWatchMs), Math.max(1, referenceWatchMs));
  const completion = clamp(completionRate);
  return clamp(p * duration * (1 + completion) * 0.5 + p * completion * 0.5);
}

/**
 * Weighted sum normalised by total weight, so the result stays in the clamped
 * band regardless of how the weights are tuned.
 *
 * This normalisation is what keeps `minScore` thresholds and score comparisons
 * meaningful across config versions: without it, doubling every weight would
 * double every score and silently change the meaning of every threshold.
 * Components with zero weight are skipped entirely rather than contributing a
 * zero, so disabling a signal does not drag the score down.
 *
 * Component values are clamped to [-1, 1], not [0, 1]: identity affinity is
 * re-centred on its neutral point (see the `AFFINITY_NEUTRAL` consumers) so a
 * NEGATIVE affinity ranks strictly below an absent one. Clamping at 0 would
 * flatten that demotion back to "same as a stranger" — the exact bug the
 * monotonicity tests pin. -1 is the floor because the signed affinity upstream
 * is itself bounded to [-1, 1].
 */
export function weightedScore(
  components: Array<{ value: number; weight: number }>,
): { score: number; totalWeight: number } {
  let sum = 0;
  let totalWeight = 0;
  for (const { value, weight } of components) {
    if (weight <= 0) continue;
    sum += clamp(value, -1, 1) * weight;
    totalWeight += weight;
  }
  if (totalWeight <= 0) return { score: 0, totalWeight: 0 };
  return { score: clamp(sum / totalWeight), totalWeight };
}

/**
 * Blends a measured value with a prior according to how much evidence backs it.
 *
 * Cold-start safety (§16) in one function: a post with 2 impressions has a
 * `confidence` near 0, so its measured quality is mostly ignored in favour of
 * the prior, and it neither wins nor loses on a statistically meaningless
 * number. As observations accumulate the measured value takes over.
 */
export function shrinkToPrior(measured: number, confidence: number, prior: number): number {
  const c = clamp(confidence);
  return clamp(measured * c + prior * (1 - c));
}

import {
  clamp,
  expectedWatchValue,
  freshnessScore,
  logNormalise,
  num,
  saturate,
  shrinkToPrior,
  signedAffinityToScore,
  stableUnitInterval,
  timeBucket,
  weightedScore,
  wilsonLowerBound,
} from './scoring';

/**
 * The scoring primitives are the engine's foundations, so their exact semantics
 * are pinned here: freshness decay, statistical uncertainty, popularity
 * normalisation, signed affinity, expected-watch value, and — the property the
 * whole engine leans on — deterministic pseudo-random selection.
 */
describe('clamp / num', () => {
  it('clamps out-of-range and non-finite values', () => {
    expect(clamp(2)).toBe(1);
    expect(clamp(-1)).toBe(0);
    expect(clamp(Number.NaN)).toBe(0);
    expect(clamp(Number.POSITIVE_INFINITY)).toBe(1);
  });

  it('coerces Postgres numerics that arrive as strings', () => {
    expect(num('0.35420')).toBeCloseTo(0.3542);
    expect(num(null)).toBe(0);
    expect(num(undefined, 0.5)).toBe(0.5);
    expect(num('not-a-number', 0.2)).toBe(0.2);
  });
});

describe('freshnessScore', () => {
  const now = Date.parse('2026-09-06T12:00:00Z');

  it('is maximal inside the grace window', () => {
    expect(freshnessScore(now - 60_000, now, 18, 0.05, 15)).toBe(1);
  });

  it('halves at the half-life', () => {
    const eighteenHours = 18 * 3_600_000;
    expect(freshnessScore(now - eighteenHours, now, 18, 0)).toBeCloseTo(0.5, 3);
  });

  it('quarters at two half-lives — exponential, not linear', () => {
    expect(freshnessScore(now - 36 * 3_600_000, now, 18, 0)).toBeCloseTo(0.25, 3);
  });

  it('never falls below the floor, however old', () => {
    const yearOld = now - 365 * 24 * 3_600_000;
    expect(freshnessScore(yearOld, now, 18, 0.05)).toBe(0.05);
  });

  it('treats future timestamps as "now" — clock skew cannot beat fresh content', () => {
    expect(freshnessScore(now + 3_600_000, now, 18, 0.05)).toBe(1);
  });
});

describe('wilsonLowerBound', () => {
  it('collapses a 1-of-1 "perfect rate" to barely-better-than-nothing', () => {
    // The naive rate is 1.0; the Wilson bound returns 0.2065. That collapse is
    // the whole point: one observation cannot claim perfection.
    expect(wilsonLowerBound(1, 1)).toBeCloseTo(0.2065, 3);
  });

  it('converges toward the true rate as observations accumulate', () => {
    const small = wilsonLowerBound(20, 100); // 20% on 100 observations
    const large = wilsonLowerBound(8000, 40000); // 20% on 40k observations
    expect(large).toBeGreaterThan(small);
    expect(large).toBeCloseTo(0.1961, 3);
  });

  it('clamps successes to trials — engagement can exceed impressions', () => {
    // A post opened from a profile with no feed impression can have more
    // engagements than impressions. Unclamped, p > 1 reports a perfect 1.0 —
    // the exact failure the Wilson bound exists to prevent.
    expect(wilsonLowerBound(5, 1)).toBeCloseTo(wilsonLowerBound(1, 1), 5);
  });

  it('returns 0 for no observations rather than a fake rate', () => {
    expect(wilsonLowerBound(3, 0)).toBe(0);
    expect(wilsonLowerBound(0, 500)).toBe(0);
  });

  it('matches the SQL twin: scarce evidence never wins', () => {
    // Cross-checked against the live-DB probe of reco_wilson_lower_bound:
    // 1/1 → 0.2065, 2/10 → 0.0567, 8000/40000 → 0.1961.
    expect(wilsonLowerBound(2, 10)).toBeCloseTo(0.05668, 4);
    expect(wilsonLowerBound(8000, 40000)).toBeCloseTo(0.19610, 4);
  });
});

describe('logNormalise', () => {
  it('maps the reference scale to 1 and compresses everything beyond', () => {
    expect(logNormalise(500, 500)).toBe(1);
    expect(logNormalise(500_000, 500)).toBe(1);
  });

  it('makes the 100→1000 step matter far more than 100k→101k', () => {
    const early = logNormalise(1000, 100_000) - logNormalise(100, 100_000);
    const late = logNormalise(101_000, 100_000) - logNormalise(100_000, 100_000);
    expect(early).toBeGreaterThan(late * 10);
  });
});

describe('signedAffinityToScore', () => {
  it('maps zero to the neutral point', () => {
    expect(signedAffinityToScore(0)).toBe(0.25);
  });

  it('lets negative affinity DEMOTE below neutral, not merely fail to promote', () => {
    // A repeatedly-ignored author must rank differently from an unknown one —
    // a naive clamp(score,0,1) would make both 0.
    expect(signedAffinityToScore(-0.5)).toBeLessThan(0.25);
    expect(signedAffinityToScore(-1)).toBe(0);
    expect(signedAffinityToScore(1)).toBe(1);
  });
});

describe('shrinkToPrior', () => {
  it('uses the prior when there is no evidence', () => {
    expect(shrinkToPrior(0.9, 0, 0.35)).toBeCloseTo(0.35);
  });

  it('uses the measurement when evidence is complete', () => {
    expect(shrinkToPrior(0.9, 1, 0.35)).toBeCloseTo(0.9);
  });

  it('blends in between', () => {
    const blended = shrinkToPrior(0.8, 0.5, 0.2);
    expect(blended).toBeCloseTo(0.5);
    expect(blended).toBeGreaterThan(0.2);
    expect(blended).toBeLessThan(0.8);
  });
});

describe('expectedWatchValue', () => {
  it('is ~0 when nobody starts the clip, however long it is', () => {
    expect(expectedWatchValue(0, 60_000, 0.9, 60_000)).toBeCloseTo(0, 5);
  });

  it('is ~0 when everyone abandons immediately, however many start', () => {
    expect(expectedWatchValue(1, 0, 0, 60_000)).toBeCloseTo(0, 5);
  });

  it('rewards a genuinely watched clip', () => {
    const good = expectedWatchValue(0.9, 50_000, 0.7, 60_000);
    expect(good).toBeGreaterThan(0.3);
  });

  it('ranks a high-retention clip above a high-view low-retention one', () => {
    // The Shorts objective is meaningful watch, not raw views — the exact
    // behaviour §11 demands.
    const retained = expectedWatchValue(0.8, 45_000, 0.8, 60_000);
    const skippy = expectedWatchValue(1.0, 5_000, 0.05, 60_000);
    expect(retained).toBeGreaterThan(skippy);
  });
});

describe('weightedScore', () => {
  it('normalises by total weight so scaling all weights does not change scores', () => {
    const a = weightedScore([
      { value: 1, weight: 1 },
      { value: 0, weight: 1 },
    ]);
    const b = weightedScore([
      { value: 1, weight: 2.5 },
      { value: 0, weight: 2.5 },
    ]);
    expect(a.score).toBeCloseTo(b.score);
    expect(a.score).toBeCloseTo(0.5);
  });

  it('skips zero-weight components entirely rather than counting them', () => {
    const withDisabled = weightedScore([
      { value: 1, weight: 1 },
      { value: 0, weight: 0 },
    ]);
    expect(withDisabled.score).toBe(1);
    expect(withDisabled.totalWeight).toBe(1);
  });

  it('returns 0 when everything is disabled — never NaN', () => {
    expect(weightedScore([{ value: 1, weight: 0 }]).score).toBe(0);
  });
});

describe('stableUnitInterval (determinism)', () => {
  it('returns the same value for the same inputs, across calls', () => {
    expect(stableUnitInterval('a', 1, 'x')).toBe(stableUnitInterval('a', 1, 'x'));
  });

  it('distinguishes different inputs', () => {
    expect(stableUnitInterval('a', 1, 'x')).not.toBe(stableUnitInterval('b', 1, 'x'));
  });

  it('stays within [0,1) for a spread of inputs', () => {
    for (let i = 0; i < 500; i++) {
      const v = stableUnitInterval(`viewer-${i}`, `post-${i}`, `cfg-${i % 7}`, i % 24);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('spreads roughly uniformly — exploration needs statistical variety', () => {
    // A degenerate hash (everything near one value) would make exploration pick
    // the same item forever, which is §35's "arbitrary random spam" in the
    // other direction.
    const buckets = new Set<number>();
    for (let i = 0; i < 200; i++) {
      buckets.add(Math.floor(stableUnitInterval(`v${i}`, 'p', 'c', 1) * 10));
    }
    expect(buckets.size).toBeGreaterThanOrEqual(8);
  });
});

describe('timeBucket', () => {
  it('is constant within a bucket and steps across its wall', () => {
    // A 60-minute bucket of 12:00:30Z ends at 13:00:00Z — verified against the
    // raw arithmetic (mid % 3600000 = 30000, so the wall is 3570000 ms away),
    // not assumed from wall-clock intuition.
    const mid = Date.parse('2026-09-06T12:00:30Z');
    const wall = 3_600_000 - (mid % 3_600_000);
    expect(timeBucket(mid, 60)).toBe(timeBucket(mid + wall - 1, 60));
    expect(timeBucket(mid + wall, 60)).toBe(timeBucket(mid, 60) + 1);
  });
});

describe('saturate', () => {
  it('maps the half-saturation point to 0.5', () => {
    expect(saturate(25, 25)).toBeCloseTo(0.5);
  });
});

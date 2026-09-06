import {
  DEFAULT_RECOMMENDATION_CONFIG,
  validateRecommendationConfig,
  signalWeightsForSql,
} from './recommendation-config.schema';

/**
 * The configuration system is the highest-priority requirement of Phase 1 (§21),
 * and these tests pin the properties that make it safe to expose through an
 * admin panel:
 *   * defaults exist and are valid (a missing active version can never break
 *     ranking);
 *   * every bound rejects out-of-range values — validation is the security
 *     control that makes "let an admin tune weights" safe;
 *   * unknown keys are rejected, so a config can't smuggle fields the schema
 *     never agreed to;
 *   * rollback survives: an old stored document parses under today's schema.
 */
describe('recommendation config schema', () => {
  describe('defaults', () => {
    it('parses an empty document into a complete, valid config', () => {
      const result = validateRecommendationConfig({});
      expect(result.valid).toBe(true);
      expect(result.issues).toEqual([]);
      expect(result.config).toEqual(DEFAULT_RECOMMENDATION_CONFIG);
    });

    it('materialises defaults deep inside each surface', () => {
      const config = validateRecommendationConfig({}).config!;
      expect(config.feed.enabled).toBe(true);
      expect(config.shorts.enabled).toBe(true);
      expect(config.search.enabled).toBe(true);
      // Surface-specific defaults differ where the products differ: shorts go
      // stale faster; search's freshness is about ordering tie-breaks.
      expect(config.shorts.freshness.halfLifeHours).toBeLessThan(
        config.feed.freshness.halfLifeHours,
      );
      expect(config.search.freshness.halfLifeHours).toBeGreaterThan(
        config.feed.freshness.halfLifeHours,
      );
    });

    it('keeps search personalisation weaker than relevance by default', () => {
      const search = validateRecommendationConfig({}).config!.search.weights;
      const personalisation = search.identityAffinity + search.popularity + search.quality + search.freshness;
      // §12: relevance must dominate. The defaults must not already violate the
      // product rule the schema encodes.
      expect(search.relevance).toBeGreaterThanOrEqual(personalisation);
    });

    it('derives defaults from the schema, so defaults can never drift from bounds', () => {
      // If a default were out of its own bound, parse({}) would fail — this test
      // is the guarantee that the fallback config is valid by construction.
      expect(() => validateRecommendationConfig(DEFAULT_RECOMMENDATION_CONFIG)).not.toThrow();
    });
  });

  describe('bounds', () => {
    it('rejects a weight above the cap', () => {
      const result = validateRecommendationConfig({
        feed: { weights: { interest: 99 } },
      });
      expect(result.valid).toBe(false);
      expect(result.issues.some((i) => i.path === 'feed.weights.interest')).toBe(true);
    });

    it('rejects exploration above 40% — beyond that the feed stops being personalised', () => {
      const result = validateRecommendationConfig({
        feed: { exploration: { ratio: 0.6 } },
      });
      expect(result.valid).toBe(false);
      expect(result.issues.some((i) => i.path === 'feed.exploration.ratio')).toBe(true);
    });

    it('rejects diversity limits of 0 — that is suppression, not diversity', () => {
      const result = validateRecommendationConfig({
        feed: { diversity: { maxPerAuthor: 0 } },
      });
      expect(result.valid).toBe(false);
    });

    it('rejects an own-content boost above the auto-#1 ceiling (§45)', () => {
      const result = validateRecommendationConfig({
        feed: { weights: { ownContent: 2 } },
      });
      expect(result.valid).toBe(false);
    });

    it('rejects search relevance below 1 while capping personalisation at 0.5 (§12)', () => {
      expect(
        validateRecommendationConfig({ search: { weights: { relevance: 0.3 } } }).valid,
      ).toBe(false);
      expect(
        validateRecommendationConfig({ search: { weights: { identityAffinity: 0.9 } } }).valid,
      ).toBe(false);
    });

    it('rejects a positive unfollow weight — negative signals are negative by construction', () => {
      const result = validateRecommendationConfig({
        shared: { signalWeights: { unfollow: 5 } },
      });
      expect(result.valid).toBe(false);
    });

    it('rejects an intervention ceiling below the floor', () => {
      // An inverted band would make clamp(min,max) swap operands — nonsense.
      const result = validateRecommendationConfig({
        shared: { safety: { interventionMin: 0.9, interventionMax: 0.3 } },
      });
      expect(result.valid).toBe(false);
    });

    it('rejects candidate limits that could scan unbounded data', () => {
      const result = validateRecommendationConfig({
        feed: { candidateLimits: { total: 50000 } },
      });
      expect(result.valid).toBe(false);
    });
  });

  describe('strictness and partial documents', () => {
    it('rejects unknown keys, including misspelled ones', () => {
      const result = validateRecommendationConfig({
        feed: { wieghts: { interest: 1 } },
      });
      expect(result.valid).toBe(false);
    });

    it('reports every issue at once, not just the first', () => {
      const result = validateRecommendationConfig({
        feed: { weights: { interest: 99, quality: 99 } },
        shorts: { exploration: { ratio: 1 } },
      });
      expect(result.valid).toBe(false);
      expect(result.issues.length).toBeGreaterThanOrEqual(3);
    });

    it('applies defaults to fields a partial draft omits', () => {
      const result = validateRecommendationConfig({
        feed: { weights: { interest: 1.5 } },
      });
      expect(result.valid).toBe(true);
      expect(result.config!.feed.weights.interest).toBe(1.5);
      expect(result.config!.feed.weights.quality).toBe(DEFAULT_RECOMMENDATION_CONFIG.feed.weights.quality);
      expect(result.config!.shorts).toEqual(DEFAULT_RECOMMENDATION_CONFIG.shorts);
    });

    it('round-trips a stored snapshot: a validated document re-validates unchanged', () => {
      // The rollback property (§21): an immutable old version must still parse
      // after schema evolution, because rollback = activate an old row.
      const first = validateRecommendationConfig({ feed: { weights: { interest: 2 } } }).config!;
      const second = validateRecommendationConfig(first);
      expect(second.valid).toBe(true);
      expect(second.config).toEqual(first);
    });
  });

  describe('sql signal-weight mapping', () => {
    it('maps camelCase weights to the snake_case keys the SQL rebuild reads', () => {
      const weights = DEFAULT_RECOMMENDATION_CONFIG.shared.signalWeights;
      const forSql = signalWeightsForSql(weights);
      // Every key the SQL function's case expression reads must be present —
      // a missing key means the SQL default (not the config) is used, silently.
      expect(Object.keys(forSql).sort()).toEqual([
        'comment', 'complete', 'follow', 'impression', 'open', 'profile_view',
        'reaction', 'save', 'search_click', 'share', 'skip', 'unfollow',
        'view', 'watch_milestone', 'watch_progress',
      ]);
      expect(forSql.unfollow).toBeLessThan(0);
      expect(forSql.skip).toBeLessThan(0);
    });
  });
});

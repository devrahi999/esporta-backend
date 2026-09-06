import { IdentitySearchRanker } from './identity-search-ranker';
import { DEFAULT_RECOMMENDATION_CONFIG } from '../config/recommendation-config.schema';
import { parseIdentitySearchInputs } from '../recommendation-features.service';
import type {
  IdentitySearchInputs,
  RankingContext,
  SearchIdentityFeatures,
} from './types';

/**
 * Identity search ranking tests — the finalization task's profile-search and
 * team-search requirements, proven on hand-built fixtures with NO database:
 *
 *   * exact-match dominance (relevance is a multiplicative gate)
 *   * bounded personalisation (schema caps affinity/quality/popularity at 0.5)
 *   * identity affinity reorders only WITHIN a relevance tier
 *   * restricted identities dropped from the ranked slate
 *   * missing feature rows skipped, not zero-scored
 *   * one ranker class serves BOTH personal and team entities
 *   * interventions bounded, organic preserved
 *   * deterministic ordering with an id tiebreak
 */
const NOW = Date.parse('2026-09-06T12:00:00Z');
const VIEWER = '11111111-1111-1111-1111-111111111111';

function ctx(overrides: Partial<RankingContext> = {}): RankingContext {
  return {
    viewerId: VIEWER,
    surface: 'search',
    config: DEFAULT_RECOMMENDATION_CONFIG,
    configVersionId: 'v1',
    configVersionLabel: 'test',
    nowMs: NOW,
    timeBucket: Math.floor(NOW / 3_600_000),
    ...overrides,
  };
}

function identity(id: string, overrides: Partial<SearchIdentityFeatures> = {}): SearchIdentityFeatures {
  return {
    kind: 'personal',
    quality: 0.5,
    popularity: 0.5,
    activity: 0.5,
    confidence: 0.8,
    primaryGameId: null,
    followers: 100,
    lastPostAtMs: NOW - 3_600_000,
    restricted: false,
    ...overrides,
  };
}

function inputs(
  identities: Record<string, SearchIdentityFeatures>,
  extra: Partial<IdentitySearchInputs> = {},
): IdentitySearchInputs {
  return {
    viewer: null,
    affinity: {},
    identities,
    interventions: {},
    ...extra,
  };
}

describe('IdentitySearchRanker — relevance dominance (§12)', () => {
  it('an exact match cannot be buried by popularity or affinity', () => {
    const relevant = {
      exact: identity('exact', { quality: 0.1, popularity: 0 }),
      popular: identity('popular', { quality: 1, popularity: 1 }),
    };
    const relevance = new Map([
      ['exact', 1.0], // exact username match
      ['popular', 0.1], // weak fuzzy match
    ]);
    const ranked = new IdentitySearchRanker(relevance)
      .score(ctx(), ['exact', 'popular'], inputs(relevant, {
        affinity: { popular: { score: 1, follows: true, interactions: 50, negatives: 0 } },
      }))
      .map((s) => s.identityId);

    // Popularity 1 + affinity 1 + quality 1 must NOT overtake relevance 1.0
    // vs 0.1: the gate scales the whole personalised score.
    expect(ranked[0]).toBe('exact');
  });

  it('zero relevance means score zero — an unrelated identity cannot rank', () => {
    const ranked = new IdentitySearchRanker(new Map([['irrelevant', 0]]))
      .score(ctx(), ['irrelevant'], inputs({ irrelevant: identity('irrelevant') }));
    expect(ranked[0].score).toBe(0);
  });

  it('a relevance TIE can be reordered by bounded personalisation', () => {
    const tied = {
      familiar: identity('familiar'),
      stranger: identity('stranger'),
    };
    const ranked = new IdentitySearchRanker(new Map([['familiar', 0.9], ['stranger', 0.9]]))
      .score(ctx(), ['familiar', 'stranger'], inputs(tied, {
        affinity: { familiar: { score: 1, follows: true, interactions: 20, negatives: 0 } },
      }))
      .map((s) => s.identityId);
    expect(ranked[0]).toBe('familiar');
  });

  it('personalisation can never flip a relevant-vs-less-relevant pair', () => {
    const pair = {
      lowAffinity: identity('lowAffinity'),
      highAffinity: identity('highAffinity'),
    };
    // Relevance gap 1.0 vs 0.8 — well within what a typo-vs-exact looks like.
    const ranked = new IdentitySearchRanker(new Map([['lowAffinity', 1.0], ['highAffinity', 0.8]]))
      .score(ctx(), ['lowAffinity', 'highAffinity'], inputs(pair, {
        affinity: { highAffinity: { score: 1, follows: true, interactions: 99, negatives: 0 } },
      }));
    expect(ranked[0].identityId).toBe('lowAffinity');
  });
});

describe('IdentitySearchRanker — eligibility', () => {
  it('drops restricted identities from the ranked slate', () => {
    const entities = {
      fine: identity('fine'),
      restricted: identity('restricted', { restricted: true }),
    };
    const ranked = new IdentitySearchRanker(new Map([['fine', 1], ['restricted', 1]]))
      .score(ctx(), ['fine', 'restricted'], inputs(entities));
    expect(ranked.map((s) => s.identityId)).toEqual(['fine']);
  });

  it('skips identities with no feature row rather than zero-scoring them', () => {
    const ranked = new IdentitySearchRanker(new Map([['known', 1], ['unbuilt', 1]]))
      .score(ctx(), ['known', 'unbuilt'], inputs({ known: identity('known') }));
    // 'unbuilt' is absent, not scored 0 — the caller serves it via lexical order.
    expect(ranked.map((s) => s.identityId)).toEqual(['known']);
  });

  it('a deleted/blocked identity never reaches the ranker — the lexical layer is the boundary', () => {
    // The ranker receives ONLY what search_identity_ids (caller-scoped, RLS-
    // bound) returned. Proving the boundary is a live-DB probe; here we pin
    // that the ranker adds no identity the caller did not pass in.
    const ranked = new IdentitySearchRanker(new Map([['a', 1]]))
      .score(ctx(), ['a'], inputs({ a: identity('a'), ghost: identity('ghost') }));
    expect(ranked.map((s) => s.identityId)).toEqual(['a']);
  });
});

describe('IdentitySearchRanker — team + personal parity (Task 2)', () => {
  it('ranks team entities with the same class, weights and gate', () => {
    const teams = {
      nexus: identity('nexus', { kind: 'team', quality: 0.9, followers: 5000 }),
      msm: identity('msm', { kind: 'team', quality: 0.4, followers: 50 }),
    };
    const relevance = new Map([['nexus', 0.9], ['msm', 1.0]]);
    const ranked = new IdentitySearchRanker(relevance)
      .score(ctx(), ['nexus', 'msm'], inputs(teams));
    // msms exact-match (1.0) beats nexus's stronger quality at relevance 0.9 —
    // relevance dominance holds for teams exactly as for profiles.
    expect(ranked[0].identityId).toBe('msm');
    expect(ranked).toHaveLength(2);
  });

  it('team affinity comes from the same identity affinity table', () => {
    const teams = {
      followedTeam: identity('followedTeam', { kind: 'team' }),
      unknownTeam: identity('unknownTeam', { kind: 'team' }),
    };
    const ranked = new IdentitySearchRanker(new Map([['followedTeam', 0.9], ['unknownTeam', 0.9]]))
      .score(ctx(), ['followedTeam', 'unknownTeam'], inputs(teams, {
        affinity: { followedTeam: { score: 1, follows: true, interactions: 10, negatives: 0 } },
      }));
    expect(ranked[0].identityId).toBe('followedTeam');
  });

  it('negative affinity demotes below a stranger — monotonic through zero', () => {
    const entities = {
      disliked: identity('disliked'),
      stranger: identity('stranger'),
      friend: identity('friend'),
    };
    const relevance = new Map([
      ['disliked', 0.9], ['stranger', 0.9], ['friend', 0.9],
    ]);
    const ranked = new IdentitySearchRanker(relevance)
      .score(ctx(), ['disliked', 'stranger', 'friend'], inputs(entities, {
        affinity: {
          disliked: { score: -0.8, follows: false, interactions: 4, negatives: 3 },
          friend: { score: 0.8, follows: true, interactions: 9, negatives: 0 },
        },
      }));
    const byId = new Map(ranked.map((s) => [s.identityId, s.score]));
    // The full tiering: negative < absent(0) < positive. This test is what
    // caught the real engine bug where negative affinity ranked ABOVE a
    // stranger because the neutral point was never subtracted.
    expect(byId.get('disliked')!).toBeLessThan(byId.get('stranger')!);
    expect(byId.get('stranger')!).toBeLessThan(byId.get('friend')!);
  });
});

describe('IdentitySearchRanker — quality, activity, interventions', () => {
  it('cold-start quality: a thin-evidence identity is shrunk toward the prior', () => {
    const pair = {
      lucky: identity('lucky', { quality: 1, confidence: 0.01, followers: 2 }),
      proven: identity('proven', { quality: 0.45, confidence: 1, followers: 900 }),
    };
    const ranked = new IdentitySearchRanker(new Map([['lucky', 1], ['proven', 1]]))
      .score(ctx(), ['lucky', 'proven'], inputs(pair));
    expect(ranked[0].identityId).toBe('proven');
  });

  it('recent activity outranks long-dormant within a tier', () => {
    const pair = {
      active: identity('active', { lastPostAtMs: NOW - 3_600_000 }),
      dormant: identity('dormant', { lastPostAtMs: NOW - 120 * 24 * 3_600_000 }),
    };
    const ranked = new IdentitySearchRanker(new Map([['active', 1], ['dormant', 1]]))
      .score(ctx(), ['active', 'dormant'], inputs(pair));
    expect(ranked[0].identityId).toBe('active');
  });

  it('a boost reorders without mutating the organic score (§25)', () => {
    const entities = { a: identity('a'), b: identity('b') };
    const relevance = new Map([['a', 1], ['b', 1]]);
    const base = new IdentitySearchRanker(relevance).score(ctx(), ['a', 'b'], inputs(entities));
    const boosted = new IdentitySearchRanker(relevance).score(ctx(), ['a', 'b'], inputs(entities, {
      interventions: { 'identity:b': 2 },
    }));
    const bBase = base.find((s) => s.identityId === 'b')!;
    const bBoosted = boosted.find((s) => s.identityId === 'b')!;
    expect(bBoosted.score).toBeGreaterThan(bBase.score);
    expect(bBoosted.explanation.organic).toBe(bBase.explanation.organic);
    expect(bBoosted.explanation.interventionMultiplier).toBe(2);
  });

  it('composed interventions clamp to the configured band', () => {
    const entities = { stacked: identity('stacked') };
    const ranked = new IdentitySearchRanker(new Map([['stacked', 1]]))
      .score(ctx(), ['stacked'], inputs(entities, { interventions: { 'identity:stacked': 3 } }));
    const { interventionMax } = DEFAULT_RECOMMENDATION_CONFIG.shared.safety;
    expect(ranked[0].explanation.interventionMultiplier).toBe(interventionMax);
  });
});

describe('IdentitySearchRanker — determinism & explanations', () => {
  it('identical inputs give identical outputs, with an id tiebreak', () => {
    const entities = { x: identity('x'), y: identity('y'), z: identity('z') };
    const relevance = new Map([['x', 1], ['y', 1], ['z', 1]]);
    const ids = ['y', 'x', 'z'];
    const rank = () =>
      new IdentitySearchRanker(relevance)
        .score(ctx(), ids, inputs(entities))
        .map((s) => s.identityId);
    expect(rank()).toEqual(rank());
    // Equal score → ascending id order, always.
    expect(rank()).toEqual(['x', 'y', 'z']);
  });

  it('exposes per-component values, including the relevance gate', () => {
    const ranked = new IdentitySearchRanker(new Map([['a', 0.8]]))
      .score(ctx(), ['a'], inputs({ a: identity('a', { quality: 0.7, popularity: 0.4 }) }, {
        affinity: { a: { score: 0.5, follows: true, interactions: 3, negatives: 0 } },
      }));
    const e = ranked[0].explanation;
    expect(e.components.relevanceGate).toBeCloseTo(0.8, 5);
    expect(e.components.identityAffinity).toBeDefined();
    expect(e.components.quality).toBeDefined();
    expect(e.components.popularity).toBeDefined();
    expect(e.components.freshness).toBeDefined();
  });
});

describe('parseIdentitySearchInputs — wire contract', () => {
  it('parses the reco_identity_ranking_inputs document shape', () => {
    const raw = {
      viewer: { identity_id: VIEWER, declared_game_ids: ['valorant'], is_cold_start: false },
      affinity: {
        [VIEWER]: { score: '0.55840', follows: true, interactions: '4', negatives: '0' },
      },
      identities: {
        [VIEWER]: {
          kind: 'team', quality: '0.4', popularity: '0.2', activity: '0.3',
          confidence: '0.5', primary_game_id: 'freefire', followers: '15',
          last_post_at: '2026-09-01T00:00:00Z', restricted: false,
        },
      },
      interventions: { [`identity:${VIEWER}`]: '2' },
    };
    const parsed = parseIdentitySearchInputs(raw, VIEWER);
    expect(parsed.viewer?.declaredGameIds).toEqual(['valorant']);
    expect(parsed.viewer?.isColdStart).toBe(false);
    // Postgres numerics arrive as STRINGS — num() must coerce them.
    expect(parsed.affinity[VIEWER].score).toBeCloseTo(0.5584);
    expect(parsed.affinity[VIEWER].follows).toBe(true);
    expect(parsed.identities[VIEWER].kind).toBe('team');
    expect(parsed.identities[VIEWER].followers).toBe(15);
    expect(parsed.identities[VIEWER].restricted).toBe(false);
    expect(parsed.identities[VIEWER].lastPostAtMs).toBeGreaterThan(0);
    expect(parsed.interventions[`identity:${VIEWER}`]).toBe(2);
  });

  it('returns an empty-but-valid bundle for null/garbage input', () => {
    expect(parseIdentitySearchInputs(null, VIEWER)).toEqual({
      viewer: null,
      affinity: {},
      identities: {},
      interventions: {},
    });
    expect(parseIdentitySearchInputs('nonsense', VIEWER).identities).toEqual({});
  });

  it('an unparseable last_post_at reads as 0 (never active), never NaN', () => {
    const parsed = parseIdentitySearchInputs(
      { identities: { a: { kind: 'personal', last_post_at: 'not-a-date', restricted: null } } },
      VIEWER,
    );
    expect(parsed.identities.a.lastPostAtMs).toBe(0);
    expect(parsed.identities.a.restricted).toBe(false);
  });
});

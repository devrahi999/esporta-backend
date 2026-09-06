import { FeedRanker, ShortsRanker, SearchRanker, applyExploration } from './rankers';
import { DEFAULT_RECOMMENDATION_CONFIG } from '../config/recommendation-config.schema';
import type {
  Candidate,
  ContentFeatures,
  RankingContext,
  RankingInputs,
  ScoredCandidate,
} from './types';

/**
 * Ranker tests — the per-surface objectives (§10, §11, §12), the identity-affinity
 * model, self-content policy (§45), interventions (§25), negative signals (§17)
 * and exploration determinism (§15, §35).
 *
 * All fixtures are hand-built: no database, no Nest. The ranker is a pure
 * function of (context, candidates, inputs), which is exactly what makes the
 * behaviours below provable.
 */
const NOW = Date.parse('2026-09-06T12:00:00Z');

const VIEWER = '11111111-1111-1111-1111-111111111111';
const FOLLOWED_AUTHOR = 'aaaaaaaa-0000-0000-0000-000000000001';
const STRANGER = 'bbbbbbbb-0000-0000-0000-000000000002';
const OWN = VIEWER;

function ctx(overrides: Partial<RankingContext> = {}): RankingContext {
  return {
    viewerId: VIEWER,
    surface: 'feed',
    config: DEFAULT_RECOMMENDATION_CONFIG,
    configVersionId: 'v1',
    configVersionLabel: 'test',
    nowMs: NOW,
    timeBucket: Math.floor(NOW / 3_600_000),
    ...overrides,
  };
}

function content(postId: string, authorId: string, overrides: Partial<ContentFeatures> = {}): ContentFeatures {
  return {
    authorId,
    typeId: 'normal',
    isShort: false,
    gameId: null,
    hasVideo: false,
    createdAtMs: NOW - 3_600_000,
    impressions: 100,
    quality: 0.5,
    popularity: 0.5,
    engagementRate: 0.2,
    completionRate: 0.5,
    avgWatchMs: 20_000,
    negativeRate: 0,
    recentEngagement: 10,
    confidence: 0.8,
    ...overrides,
  };
}

function candidate(postId: string): Candidate {
  return { postId, source: 'quality', rankInSource: 1 };
}

function inputs(contentByPost: Record<string, ContentFeatures>, extra: Partial<RankingInputs> = {}): RankingInputs {
  return {
    viewer: {
      identityId: VIEWER,
      declaredGameIds: [],
      declaredRoleId: null,
      followingCount: 5,
      shortAffinity: 0.5,
      videoAffinity: 0.5,
      engagementTendency: 0.4,
      watchTendency: 0.5,
      avgWatchMs: 20_000,
      explorationAppetite: 0.5,
      interactionCount: 100,
      confidence: 1,
      isColdStart: false,
    },
    viewerTopics: {},
    authorAffinity: {},
    authorFeatures: {},
    content: contentByPost,
    interventions: {},
    exposures: {},
    ...extra,
  };
}

/** Equal-quality posts, one from a followed author, one from a stranger. */
function affinityFixture() {
  return {
    contentByPost: {
      familiar: content('familiar', FOLLOWED_AUTHOR),
      stranger: content('stranger', STRANGER),
    },
    extra: {
      authorAffinity: {
        [FOLLOWED_AUTHOR]: { score: 1, follows: true, interactions: 20, negatives: 0 },
        [STRANGER]: { score: 0, follows: false, interactions: 0, negatives: 0 },
      },
    } satisfies Partial<RankingInputs>,
  };
}

describe('FeedRanker', () => {
  it('ranks a familiar author above an equal stranger (identity-centric model)', () => {
    const { contentByPost, extra } = affinityFixture();
    const scored = new FeedRanker().score(
      ctx(),
      [candidate('familiar'), candidate('stranger')],
      inputs(contentByPost, extra),
    );
    const familiar = scored.find((s) => s.postId === 'familiar')!;
    const stranger = scored.find((s) => s.postId === 'stranger')!;
    expect(familiar.score).toBeGreaterThan(stranger.score);
  });

  it('keeps identity affinity and interest as separate observable components', () => {
    const { contentByPost, extra } = affinityFixture();
    contentByPost.familiar.gameId = 'valorant';
    const scored = new FeedRanker().score(
      ctx(),
      [candidate('familiar')],
      inputs(contentByPost, { ...extra, viewerTopics: { 'game:valorant': 0.9 } }),
    );
    const components = scored[0].explanation.components;
    expect(components.identityAffinity).toBeDefined();
    expect(components.interest).toBeDefined();
    expect(components.identityAffinity).not.toBe(components.interest);
  });

  it('demotes a negatively-affined author below a stranger — negative affinity demotes', () => {
    const contentByPost = {
      disliked: content('disliked', FOLLOWED_AUTHOR),
      stranger: content('stranger', STRANGER),
    };
    const scored = new FeedRanker().score(
      ctx(),
      [candidate('disliked'), candidate('stranger')],
      inputs(contentByPost, {
        authorAffinity: {
          [FOLLOWED_AUTHOR]: { score: -0.8, follows: false, interactions: 5, negatives: 4 },
          [STRANGER]: { score: 0, follows: false, interactions: 0, negatives: 0 },
        },
      }),
    );
    const disliked = scored.find((s) => s.postId === 'disliked')!;
    const stranger = scored.find((s) => s.postId === 'stranger')!;
    expect(disliked.score).toBeLessThan(stranger.score);
  });

  it('keeps the affinity mapping strictly monotonic through zero', () => {
    // negative < absent(0) < positive — the tiering the whole demotion contract
    // rests on. A negative-affinity author must rank BELOW a stranger, not
    // between a stranger and a friend (which is what an un-re-centred mapping
    // produced — a real engine bug the identity-search tests caught).
    const NEG = 'cccccccc-0000-0000-0000-000000000003';
    const POS = 'cccccccc-0000-0000-0000-000000000005';
    const contentByPost = {
      neg: content('neg', NEG),
      absent: content('absent', 'cccccccc-0000-0000-0000-000000000004'),
      pos: content('pos', POS),
    };
    const scored = new FeedRanker().score(
      ctx(),
      [candidate('neg'), candidate('absent'), candidate('pos')],
      inputs(contentByPost, {
        authorAffinity: {
          [NEG]: { score: -0.8, follows: false, interactions: 4, negatives: 3 },
          [POS]: { score: 0.8, follows: true, interactions: 9, negatives: 0 },
        },
      }),
    );
    const byId = new Map(scored.map((s) => [s.postId, s.score]));
    expect(byId.get('neg')!).toBeLessThan(byId.get('absent')!);
    expect(byId.get('absent')!).toBeLessThan(byId.get('pos')!);
  });

  it('§45: own content ranks, but never above a familiar author on equal quality', () => {
    const { extra } = affinityFixture();
    const contentByPost: Record<string, ContentFeatures> = {
      familiar: content('familiar', FOLLOWED_AUTHOR),
      stranger: content('stranger', STRANGER),
      mine: content('mine', OWN),
    };
    const scored = new FeedRanker().score(
      ctx(),
      [candidate('familiar'), candidate('mine'), candidate('stranger')],
      inputs(contentByPost, extra),
    );
    const mine = scored.find((s) => s.postId === 'mine')!;
    const familiar = scored.find((s) => s.postId === 'familiar')!;
    const stranger = scored.find((s) => s.postId === 'stranger')!;
    // Own content is IN the feed and beats an unknown author (it is relevant to
    // the user), but the bounded ownContent weight keeps it below a followed
    // author's equal-quality post.
    expect(scored).toHaveLength(3);
    expect(mine.score).toBeGreaterThan(stranger.score);
    expect(mine.score).toBeLessThan(familiar.score);
  });

  it('a fresh post beats a stale one of equal quality', () => {
    const contentByPost = {
      fresh: content('fresh', STRANGER, { createdAtMs: NOW - 60_000 }),
      stale: content('stale', STRANGER, { createdAtMs: NOW - 20 * 24 * 3_600_000 }),
    };
    const scored = new FeedRanker().score(
      ctx(),
      [candidate('fresh'), candidate('stale')],
      inputs(contentByPost),
    );
    expect(scored.find((s) => s.postId === 'fresh')!.score).toBeGreaterThan(
      scored.find((s) => s.postId === 'stale')!.score,
    );
  });

  it('penalises repetition from the exposure log', () => {
    const contentByPost = { seen: content('seen', STRANGER), fresh: content('fresh', STRANGER) };
    const scored = new FeedRanker().score(
      ctx(),
      [candidate('seen'), candidate('fresh')],
      inputs(contentByPost, { exposures: { seen: { shown: 2, lastShownAtMs: NOW } } }),
    );
    const seen = scored.find((s) => s.postId === 'seen')!;
    expect(seen.explanation.penalties.repetition).toBeGreaterThan(0);
    expect(seen.score).toBeLessThan(scored.find((s) => s.postId === 'fresh')!.score);
  });

  it('applies negative feedback as a penalty', () => {
    const contentByPost = { reported: content('reported', STRANGER, { negativeRate: 0.4 }) };
    const [scored] = new FeedRanker().score(ctx(), [candidate('reported')], inputs(contentByPost));
    expect(scored.explanation.penalties.negativeFeedback).toBeCloseTo(0.4);
  });

  it('§25: a boost raises the score without mutating the organic one', () => {
    const contentByPost = { boosted: content('boosted', STRANGER) };
    const base = new FeedRanker().score(ctx(), [candidate('boosted')], inputs(contentByPost))[0];
    const boosted = new FeedRanker().score(
      ctx(),
      [candidate('boosted')],
      inputs(contentByPost, { interventions: { 'post:boosted': 2 } }),
    )[0];
    expect(boosted.score).toBeGreaterThan(base.score);
    expect(boosted.explanation.organic).toBe(base.explanation.organic);
    expect(boosted.explanation.interventionMultiplier).toBe(2);
  });

  it('clamps composed interventions to the configured band — stacking cannot exceed it', () => {
    const contentByPost = { stacked: content('stacked', STRANGER) };
    const scored = new FeedRanker().score(
      ctx(),
      [candidate('stacked')],
      inputs(contentByPost, { interventions: { 'post:stacked': 3, [FOLLOWED_AUTHOR ? `identity:${STRANGER}` : '']: 3 } as Record<string, number> }),
    );
    const { interventionMax } = DEFAULT_RECOMMENDATION_CONFIG.shared.safety;
    expect(scored[0].explanation.interventionMultiplier).toBe(interventionMax);
  });

  it('is fully deterministic: identical inputs give identical outputs', () => {
    const { contentByPost, extra } = affinityFixture();
    const rank = () =>
      new FeedRanker()
        .score(ctx(), [candidate('familiar'), candidate('stranger')], inputs(contentByPost, extra))
        .map((s) => s.postId);
    expect(rank()).toEqual(rank());
  });

  it('cold-start quality: a post with 2 impressions does not win on a meaningless rate', () => {
    const contentByPost = {
      lucky: content('lucky', STRANGER, { quality: 0.9, confidence: 0.01, impressions: 2 }),
      proven: content('proven', STRANGER, { quality: 0.45, confidence: 1, impressions: 5_000 }),
    };
    const scored = new FeedRanker().score(
      ctx(),
      [candidate('lucky'), candidate('proven')],
      inputs(contentByPost),
    );
    // The prior pulls the lucky post back below the proven one.
    expect(scored.find((s) => s.postId === 'proven')!.score).toBeGreaterThan(
      scored.find((s) => s.postId === 'lucky')!.score,
    );
  });
});

describe('ShortsRanker', () => {
  function shortContent(postId: string, authorId: string, overrides: Partial<ContentFeatures> = {}) {
    return content(postId, authorId, { typeId: 'short', isShort: true, hasVideo: true, ...overrides });
  }

  it('ranks retention over raw views: a watched clip beats a skipped one', () => {
    const contentByPost = {
      retained: shortContent('retained', STRANGER, {
        completionRate: 0.8, avgWatchMs: 50_000, impressions: 1_000,
      }),
      skippy: shortContent('skippy', STRANGER, {
        completionRate: 0.02, avgWatchMs: 2_000, impressions: 500_000, popularity: 1,
      }),
    };
    const scored = new ShortsRanker().score(
      ctx({ surface: 'shorts' }),
      [candidate('retained'), candidate('skippy')],
      inputs(contentByPost),
    );
    expect(scored.find((s) => s.postId === 'retained')!.score).toBeGreaterThan(
      scored.find((s) => s.postId === 'skippy')!.score,
    );
  });

  it('explains the watch objective through its components', () => {
    const contentByPost = { clip: shortContent('clip', STRANGER) };
    const [scored] = new ShortsRanker().score(
      ctx({ surface: 'shorts' }),
      [candidate('clip')],
      inputs(contentByPost),
    );
    expect(scored.explanation.components.watchProbability).toBeDefined();
    expect(scored.explanation.components.expectedWatch).toBeDefined();
    expect(scored.explanation.components.completion).toBeDefined();
  });

  it('§11: tighter repetition control on shorts (exposure drop happens upstream)', () => {
    const contentByPost = { reclip: shortContent('reclip', STRANGER) };
    const [scored] = new ShortsRanker().score(
      ctx({ surface: 'shorts' }),
      [candidate('reclip')],
      inputs(contentByPost, { exposures: { reclip: { shown: 1, lastShownAtMs: NOW } } }),
    );
    expect(scored.explanation.penalties.repetition).toBeGreaterThan(0);
  });
});

describe('SearchRanker (§12 relevance dominance)', () => {
  it('a weak relevance match cannot be rescued by affinity or popularity', () => {
    const contentByPost = {
      exact: content('exact', STRANGER),
      tangential: content('tangential', FOLLOWED_AUTHOR, { popularity: 1 }),
    };
    const relevance = new Map([
      ['exact', 1.0],
      ['tangential', 0.1],
    ]);
    const scored = new SearchRanker(relevance).score(
      ctx({ surface: 'search' }),
      [candidate('exact'), candidate('tangential')],
      inputs(contentByPost, {
        authorAffinity: {
          [FOLLOWED_AUTHOR]: { score: 1, follows: true, interactions: 50, negatives: 0 },
        },
      }),
    );
    expect(scored.find((s) => s.postId === 'exact')!.score).toBeGreaterThan(
      scored.find((s) => s.postId === 'tangential')!.score,
    );
  });

  it('zero relevance means score zero — an unrelated item cannot rank at all', () => {
    const contentByPost = { unrelated: content('unrelated', STRANGER) };
    const scored = new SearchRanker(new Map([['unrelated', 0]])).score(
      ctx({ surface: 'search' }),
      [candidate('unrelated')],
      inputs(contentByPost),
    );
    expect(scored[0].score).toBe(0);
  });

  it('does not penalise repetition in search — someone searching wants the thing', () => {
    const contentByPost = { result: content('result', STRANGER) };
    const scored = new SearchRanker(new Map([['result', 1]])).score(
      ctx({ surface: 'search' }),
      [candidate('result')],
      inputs(contentByPost, { exposures: { result: { shown: 5, lastShownAtMs: NOW } } }),
    );
    expect(scored[0].explanation.penalties.repetition).toBeUndefined();
  });
});

describe('applyExploration (§15, §35)', () => {
  function flatItems(n: number): ScoredCandidate[] {
    return Array.from({ length: n }, (_, i) => ({
      postId: `exp-${i}`,
      authorId: STRANGER,
      score: 1 - i * 0.01,
      explanation: {
        total: 1 - i * 0.01,
        organic: 1 - i * 0.01,
        components: {},
        penalties: {},
        interventionMultiplier: 1,
        exploration: false,
        source: 'quality',
      },
      gameId: null,
      typeId: 'normal',
      createdAtMs: NOW,
    }));
  }

  it('reserves slots from below the exploitative cut and marks them', () => {
    const result = applyExploration(ctx(), flatItems(50), 20, false);
    const marked = result.filter((item) => item.explanation.exploration);
    expect(marked.length).toBeGreaterThan(0);
    expect(marked.length).toBeLessThanOrEqual(20);
  });

  it('is deterministic: the same viewer/config/bucket always picks the same items', () => {
    const first = applyExploration(ctx(), flatItems(50), 20, false)
      .filter((i) => i.explanation.exploration)
      .map((i) => i.postId)
      .sort();
    const second = applyExploration(ctx(), flatItems(50), 20, false)
      .filter((i) => i.explanation.exploration)
      .map((i) => i.postId)
      .sort();
    expect(first).toEqual(second);
  });

  it('changes picks when the time bucket changes — exploration rotates, not freezes', () => {
    const picksIn = (bucket: number) =>
      applyExploration(ctx({ timeBucket: bucket }), flatItems(80), 20, false)
        .filter((i) => i.explanation.exploration)
        .map((i) => i.postId);
    // Scan buckets until the pick SET genuinely changes vs bucket 100. Asserting
    // "every adjacent pair differs" is a stronger claim than uniform hashing
    // makes — consecutive buckets CAN collide by chance, and that is fine; what
    // must be true is that rotation HAPPENS.
    const first = [...picksIn(100)].sort();
    let rotated = false;
    for (let bucket = 101; bucket <= 130 && !rotated; bucket++) {
      rotated = ![...picksIn(bucket)].sort().every((id, i) => id === first[i]);
    }
    expect(rotated).toBe(true);
  });

  it('gives a cold-start viewer more exploration than a warm one', () => {
    const cold = applyExploration(ctx(), flatItems(50), 20, true)
      .filter((i) => i.explanation.exploration).length;
    const warm = applyExploration(ctx(), flatItems(50), 20, false)
      .filter((i) => i.explanation.exploration).length;
    expect(cold).toBeGreaterThan(warm);
  });

  it('never explores below the quality floor', () => {
    const config = structuredClone(DEFAULT_RECOMMENDATION_CONFIG);
    config.feed.exploration.minQuality = 0.5;
    const result = applyExploration(ctx({ config }), flatItems(50), 20, false);
    for (const item of result) {
      if (item.explanation.exploration) {
        expect(item.score).toBeGreaterThanOrEqual(0.5);
      }
    }
  });

  it('does nothing on the search surface — search stays query-driven', () => {
    const result = applyExploration(ctx({ surface: 'search' }), flatItems(50), 20, false);
    expect(result).toEqual(flatItems(50));
  });
});

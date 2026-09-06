import { applyDiversity } from './reranker';
import type { DiversityConfig } from '../config/recommendation-config.schema';
import type { ScoredCandidate } from './types';

/**
 * Diversity re-ranking tests (§13).
 *
 * These pin the two properties the stage exists for: monotonous sequences are
 * broken up, and nothing is LOST — an item is deferred, never discarded, so a
 * page still comes back full.
 */
const LIMITS: DiversityConfig = {
  maxPerAuthor: 2,
  maxPerGame: 4,
  maxPerContentType: 5,
  windowSize: 10,
  repetitionPenalty: 0.45,
  maxExposuresBeforeDrop: 3,
  exposureWindowHours: 72,
};

function item(postId: string, authorId: string, score: number, gameId: string | null = null): ScoredCandidate {
  return {
    postId,
    authorId,
    score,
    explanation: {
      total: score,
      organic: score,
      components: {},
      penalties: {},
      interventionMultiplier: 1,
      exploration: false,
      source: 'quality',
    },
    gameId,
    typeId: 'normal',
    createdAtMs: 0,
  };
}

describe('applyDiversity', () => {
  it('breaks up a run of posts from one author without dropping any', () => {
    const scored = [
      item('p1', 'authorA', 0.9),
      item('p2', 'authorA', 0.8),
      item('p3', 'authorA', 0.7),
      item('p4', 'authorB', 0.6),
      item('p5', 'authorC', 0.5),
    ];
    const result = applyDiversity(scored, LIMITS);
    // Everything survives.
    expect(result.map((i) => i.postId).sort()).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
    // No more than LIMITS.maxPerAuthor consecutive from one author in the window.
    const firstThreeAuthors = result.slice(0, 3).map((i) => i.authorId);
    const authorA = firstThreeAuthors.filter((a) => a === 'authorA').length;
    expect(authorA).toBeLessThanOrEqual(LIMITS.maxPerAuthor);
  });

  it('keeps score order when no constraint binds', () => {
    const scored = [
      item('p1', 'a', 0.9, 'valorant'),
      item('p2', 'b', 0.8, 'freefire'),
      item('p3', 'c', 0.7, 'csgo'),
    ];
    const result = applyDiversity(scored, LIMITS);
    expect(result.map((i) => i.postId)).toEqual(['p1', 'p2', 'p3']);
  });

  it('spreads a same-game run across the window', () => {
    const scored = [
      item('g1', 'a1', 0.9, 'valorant'),
      item('g2', 'a2', 0.8, 'valorant'),
      item('g3', 'a3', 0.7, 'valorant'),
      item('g4', 'a4', 0.6, 'valorant'),
      item('g5', 'a5', 0.5, 'valorant'),
      item('g6', 'a6', 0.4, 'freefire'),
    ];
    const result = applyDiversity(scored, LIMITS);
    const window = result.slice(0, 5);
    const valorant = window.filter((i) => i.gameId === 'valorant').length;
    expect(valorant).toBeLessThanOrEqual(LIMITS.maxPerGame);
    expect(result).toHaveLength(6);
  });

  it('does not treat null game as a topic — untagged posts are not "the same game"', () => {
    const scored = [
      item('u1', 'a', 0.9, null),
      item('u2', 'b', 0.8, null),
      item('u3', 'c', 0.7, null),
      item('u4', 'd', 0.6, null),
      item('u5', 'e', 0.5, null),
    ];
    const result = applyDiversity(scored, LIMITS);
    expect(result.map((i) => i.postId)).toEqual(['u1', 'u2', 'u3', 'u4', 'u5']);
  });

  it('falls through to best-available when nothing fits — a full page beats a short one', () => {
    // One author, one game, one type: every constraint is breached immediately
    // after the second item. The ranker must still return everything.
    const scored = [
      item('x1', 'a', 0.9, 'valorant'),
      item('x2', 'a', 0.8, 'valorant'),
      item('x3', 'a', 0.7, 'valorant'),
      item('x4', 'a', 0.6, 'valorant'),
    ];
    const result = applyDiversity(scored, LIMITS);
    expect(result).toHaveLength(4);
  });

  it('is deterministic — identical inputs give identical outputs', () => {
    const scored = [
      item('d1', 'a', 0.5, 'g'),
      item('d2', 'a', 0.5, 'g'),
      item('d3', 'b', 0.5, 'g'),
      item('d4', 'b', 0.5, 'g'),
    ];
    const first = applyDiversity(scored, LIMITS).map((i) => i.postId);
    const second = applyDiversity(scored, LIMITS).map((i) => i.postId);
    expect(first).toEqual(second);
  });

  it('breaks ties by post id so the ordering is fully deterministic (§35)', () => {
    const scored = [
      item('b', 'a', 0.5),
      item('a', 'b', 0.5),
      item('c', 'c', 0.5),
    ];
    const result = applyDiversity(scored, LIMITS);
    expect(result.map((i) => i.postId)).toEqual(['a', 'b', 'c']);
  });
});

import type { DiversityConfig } from '../config/recommendation-config.schema';
import type { RankingContext, RankingInputs, RerankerPort, ScoredCandidate } from './types';

/**
 * Diversity re-ranking (§13), shared by every surface.
 *
 * ONE implementation, driven by {@link DiversityConfig}, because the failure mode
 * this prevents is a per-surface copy: three near-identical loops in feed, shorts
 * and search that drift apart until "max 2 per author" quietly means something
 * different in each. Feed, Shorts and Search pass different *limits*; the
 * algorithm is identical.
 *
 * It is a GREEDY CONSTRAINED SELECTION, not a sort. Walking the score-ordered
 * list and taking the best item that does not violate a window constraint
 * preserves the ranker's judgement wherever it can, and only defers an item when
 * taking it would make the slate monotonous. Re-sorting by a "diversity-adjusted
 * score" instead would let a low-scoring item overtake a high-scoring one
 * outright, which is a different and worse trade.
 *
 * Deferred items are not discarded — they sink to the end in score order. Losing
 * them would shrink the page below its requested size and make the ranker look
 * like it ran out of content.
 */
export class DiversityReranker implements RerankerPort {
  rerank(ctx: RankingContext, scored: ScoredCandidate[], _inputs: RankingInputs): ScoredCandidate[] {
    const limits = diversityFor(ctx);
    if (!limits) return scored;
    return applyDiversity(scored, limits);
  }
}

/** Search has no diversity block in its config — relevance ordering is the point. */
function diversityFor(ctx: RankingContext): DiversityConfig | null {
  if (ctx.surface === 'feed') return ctx.config.feed.diversity;
  if (ctx.surface === 'shorts') return ctx.config.shorts.diversity;
  return null;
}

/**
 * Greedy window-constrained reordering.
 *
 * Exported for direct unit testing: the window arithmetic is the part most likely
 * to be subtly wrong, and testing it through a full ranking request would hide
 * that.
 */
export function applyDiversity(
  scored: ScoredCandidate[],
  limits: DiversityConfig,
): ScoredCandidate[] {
  if (scored.length <= 1) return scored;

  const ordered = [...scored].sort(byScoreThenId);
  const result: ScoredCandidate[] = [];
  const remaining = new Set<number>(ordered.map((_, i) => i));

  while (remaining.size > 0) {
    let picked = -1;

    for (const index of remaining) {
      if (fitsWindow(result, ordered[index], limits)) {
        picked = index;
        break; // `remaining` iterates in score order, so the first fit is the best fit.
      }
    }

    // Nothing fits — every candidate would breach a window limit. Taking the
    // best-scoring one anyway is deliberate: the alternative is an empty or
    // short page, and a slightly repetitive feed beats no feed. This is reached
    // when the pool genuinely lacks variety (a small catalogue, or one prolific
    // author), which is a content problem the ranker cannot fix.
    if (picked === -1) {
      picked = remaining.values().next().value as number;
    }

    result.push(ordered[picked]);
    remaining.delete(picked);
  }

  return result;
}

/**
 * Whether `candidate` may be appended without breaching a limit in the trailing
 * window.
 *
 * The window looks back `windowSize - 1` places, because the candidate itself
 * occupies the last slot of the window it is being tested against — using
 * `windowSize` would test a window of `windowSize + 1`.
 */
function fitsWindow(
  chosen: ScoredCandidate[],
  candidate: ScoredCandidate,
  limits: DiversityConfig,
): boolean {
  const window = chosen.slice(Math.max(0, chosen.length - (limits.windowSize - 1)));

  let sameAuthor = 0;
  let sameGame = 0;
  let sameType = 0;

  for (const item of window) {
    if (item.authorId === candidate.authorId) sameAuthor++;
    // Null game is not a topic — two posts with no game are not "the same game",
    // and treating them as such would throttle the whole untagged catalogue.
    if (candidate.gameId !== null && item.gameId === candidate.gameId) sameGame++;
    if (item.typeId === candidate.typeId) sameType++;
  }

  return (
    sameAuthor < limits.maxPerAuthor &&
    sameGame < limits.maxPerGame &&
    sameType < limits.maxPerContentType
  );
}

/**
 * Score descending, post id ascending as the tiebreak.
 *
 * The id tiebreak is what makes the whole ordering deterministic (§35): two
 * items with identical scores would otherwise be ordered by whatever sequence
 * the database happened to return, so page 2 of a paginated slate could differ
 * between two identical requests.
 */
export function byScoreThenId(a: ScoredCandidate, b: ScoredCandidate): number {
  if (b.score !== a.score) return b.score - a.score;
  return a.postId < b.postId ? -1 : a.postId > b.postId ? 1 : 0;
}

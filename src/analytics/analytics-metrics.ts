/**
 * Pure metric helpers for the analytics read layer (Part 2).
 *
 * Everything here is a deterministic function of plain inputs — no I/O, no
 * Nest, no Supabase — so the metric semantics (bucketing, engagement rate,
 * totals) can be unit-tested without a database. The SQL aggregation proves
 * the numbers; these functions prove the shapes Part 3 will consume.
 */

export type Granularity = 'day' | 'week' | 'month';

/** `YYYY-MM-DD`, the daily bucket key. Input is a UTC date or ISO timestamp. */
export function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The Monday that starts the ISO week containing [date] (ISO 8601: weeks run
 * Monday–Sunday), as `YYYY-MM-DD`. Weekly metrics are derived by summing the
 * daily rows whose stat_date falls in [monday, monday+7).
 */
export function weekKey(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay(); // 0 = Sunday … 6 = Saturday
  const backToMonday = (day + 6) % 7;
  d.setUTCDate(d.getUTCDate() - backToMonday);
  return dayKey(d);
}

/** The calendar month containing [date], as `YYYY-MM`. */
export function monthKey(date: Date): string {
  return date.toISOString().slice(0, 7);
}

/** The bucket key for [date] at the requested granularity. */
export function bucketKey(date: Date, granularity: Granularity): string {
  switch (granularity) {
    case 'week':
      return weekKey(date);
    case 'month':
      return monthKey(date);
    default:
      return dayKey(date);
  }
}

export interface MetricTotals {
  impressions: number;
  views: number;
  opens: number;
  reactions: number;
  comments: number;
  shares: number;
  saves: number;
  reach: number;
}

export function emptyTotals(): MetricTotals {
  return {
    impressions: 0,
    views: 0,
    opens: 0,
    reactions: 0,
    comments: 0,
    shares: 0,
    saves: 0,
    reach: 0,
  };
}

/** Sums two totals objects into a new one. */
export function addTotals(a: MetricTotals, b: MetricTotals): MetricTotals {
  return {
    impressions: a.impressions + b.impressions,
    views: a.views + b.views,
    opens: a.opens + b.opens,
    reactions: a.reactions + b.reactions,
    comments: a.comments + b.comments,
    shares: a.shares + b.shares,
    saves: a.saves + b.saves,
    reach: a.reach + b.reach,
  };
}

/**
 * Engagement = reactions + comments + shares + saves (plan Part 2 semantics).
 */
export function engagementOf(t: MetricTotals): number {
  return t.reactions + t.comments + t.shares + t.saves;
}

/**
 * Engagement rate = engagement / reach. The denominator is EXPLICITLY
 * unique reach (distinct accounts with >= 1 impression or view in the
 * period) — not impressions and not views, and the choice is fixed here so
 * every consumer reports the same number. When nothing was reached the rate
 * is undefined: zero over zero is not zero percent, it is "no signal", and
 * the API returns null rather than a fake 0.
 */
export function engagementRate(t: MetricTotals): number | null {
  if (t.reach <= 0) return null;
  return engagementOf(t) / t.reach;
}

/**
 * Groups dated rows into buckets of [granularity] and sums their metrics.
 * Rows may arrive in any order; duplicates of the same (bucket, key) row are
 * the caller's problem (they never occur — daily rows are unique per
 * stat_date) — here every row counts once.
 */
export function bucketSeries<T extends { stat_date: string }>(
  rows: T[],
  granularity: Granularity,
  pick: (row: T) => Partial<MetricTotals>,
): Array<{ bucket: string; totals: MetricTotals }> {
  const buckets = new Map<string, MetricTotals>();
  for (const row of rows) {
    const key = bucketKey(new Date(`${row.stat_date}T00:00:00Z`), granularity);
    const current = buckets.get(key) ?? emptyTotals();
    const add = pick(row);
    buckets.set(key, {
      impressions: current.impressions + (add.impressions ?? 0),
      views: current.views + (add.views ?? 0),
      opens: current.opens + (add.opens ?? 0),
      reactions: current.reactions + (add.reactions ?? 0),
      comments: current.comments + (add.comments ?? 0),
      shares: current.shares + (add.shares ?? 0),
      saves: current.saves + (add.saves ?? 0),
      reach: current.reach + (add.reach ?? 0),
    });
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([bucket, totals]) => ({ bucket, totals }));
}

/**
 * Validates a `[from, to]` date range for a read request. Returns the parsed
 * UTC dates or a sentence describing the first problem (the caller turns it
 * into a 400). Range is capped so one dashboard request can never read an
 * unbounded slice of the daily layer.
 */
export function parseRange(from: string, to: string, maxDays = 366): { from: Date; to: Date } | string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return 'from and to must be YYYY-MM-DD dates.';
  }
  const f = new Date(`${from}T00:00:00Z`);
  const t = new Date(`${to}T00:00:00Z`);
  if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime())) {
    return 'from and to must be valid calendar dates.';
  }
  if (f > t) return 'from must be on or before to.';
  const days = Math.round((t.getTime() - f.getTime()) / 86_400_000) + 1;
  if (days > maxDays) return `range is limited to ${maxDays} days.`;
  return { from: f, to: t };
}

/** Inclusive day count of an ISO `[from, to]` range. */
export function daysInRange(fromIso: string, toIso: string): number {
  const f = new Date(`${fromIso}T00:00:00Z`).getTime();
  const t = new Date(`${toIso}T00:00:00Z`).getTime();
  return Math.round((t - f) / 86_400_000) + 1;
}

/**
 * The equal-length window immediately before `[from, to]`, for period-over-period
 * comparison. A 7-day range ending today compares against the 7 days before it,
 * so the two windows are the same width and never overlap — comparing a 7-day
 * span against a 30-day one would make every card lie.
 */
export function previousRange(
  fromIso: string,
  toIso: string,
): { from: string; to: string } {
  const span = daysInRange(fromIso, toIso);
  const fromMs = new Date(`${fromIso}T00:00:00Z`).getTime();
  const prevTo = new Date(fromMs - 86_400_000);
  const prevFrom = new Date(fromMs - span * 86_400_000);
  return { from: dayKey(prevFrom), to: dayKey(prevTo) };
}

/**
 * A period-over-period delta.
 *
 * `percent` is deliberately `null` when the previous period is 0: growth from
 * nothing has no defined percentage, and rendering "+100%" or "+∞%" for a
 * creator's first week of traffic is a lie the UI would then have to explain.
 * The absolute change is always meaningful, so it is always present, and the
 * client shows the raw delta when `percent` is null.
 */
export interface MetricChange {
  current: number;
  previous: number;
  absolute: number;
  percent: number | null;
}

export function changeOf(current: number, previous: number): MetricChange {
  const absolute = current - previous;
  return {
    current,
    previous,
    absolute,
    percent: previous === 0 ? null : absolute / previous,
  };
}

/**
 * Completion rate = completes / watch starts. Null when nothing started, for the
 * same reason `engagementRate` is null at zero reach: no signal is not 0%.
 */
export function completionRate(starts: number, completes: number): number | null {
  if (starts <= 0) return null;
  return completes / starts;
}

/**
 * A per-unit average (views per post, watch time per start, events per session,
 * views per reached account). Null when there are no units.
 *
 * Every average and ratio the dashboards show goes through this one function so
 * the zero-denominator answer is the same everywhere: `null`, meaning "no
 * signal". A UI that divided by zero itself would have to invent 0, NaN or
 * Infinity, and each of those reads as a real measurement to an operator.
 */
export function ratioOf(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return numerator / denominator;
}

import {
  addTotals,
  bucketSeries,
  changeOf,
  completionRate,
  dayKey,
  bucketKey,
  daysInRange,
  engagementOf,
  engagementRate,
  emptyTotals,
  monthKey,
  parseRange,
  previousRange,
  weekKey,
} from './analytics-metrics';

/**
 * Unit tests for the Part 2 metric semantics — the shapes and rules every
 * dashboard (and the future recommendation engine) consumes. The SQL
 * aggregation itself is proven by transactional probes against the live
 * database (see docs/ANALYTICS_PART2.md); these tests pin the pure logic
 * that turns daily rows into the API contract.
 */

describe('date bucketing', () => {
  it('keys a day by its UTC calendar date', () => {
    // 23:59:59.999 UTC still belongs to its own day.
    expect(dayKey(new Date('2026-08-20T23:59:59.999Z'))).toBe('2026-08-20');
    expect(dayKey(new Date('2026-08-21T00:00:00.000Z'))).toBe('2026-08-21');
  });

  it('starts the ISO week on Monday across the Sunday/Monday boundary', () => {
    // 2026-08-16 is a Sunday, 2026-08-17 its Monday.
    expect(weekKey(new Date('2026-08-16T12:00:00Z'))).toBe('2026-08-10');
    expect(weekKey(new Date('2026-08-17T00:00:00Z'))).toBe('2026-08-17');
    // Mid-week days share the Monday key.
    expect(weekKey(new Date('2026-08-20T09:00:00Z'))).toBe('2026-08-17');
    // Year-wrap: 2026-01-01 (Thursday) belongs to the week starting 2025-12-29.
    expect(weekKey(new Date('2026-01-01T12:00:00Z'))).toBe('2025-12-29');
  });

  it('keys months as YYYY-MM in UTC', () => {
    expect(monthKey(new Date('2026-08-20T10:00:00Z'))).toBe('2026-08');
    expect(monthKey(new Date('2026-12-31T23:00:00Z'))).toBe('2026-12');
    expect(monthKey(new Date('2027-01-01T00:00:00Z'))).toBe('2027-01');
  });

  it('routes bucketKey by granularity', () => {
    const d = new Date('2026-08-20T10:00:00Z');
    expect(bucketKey(d, 'day')).toBe('2026-08-20');
    expect(bucketKey(d, 'week')).toBe('2026-08-17');
    expect(bucketKey(d, 'month')).toBe('2026-08');
  });
});

describe('engagement semantics', () => {
  it('engagement = reactions + comments + shares + saves', () => {
    const t = { ...emptyTotals(), reactions: 2, comments: 3, shares: 1, saves: 4 };
    expect(engagementOf(t)).toBe(10);
  });

  it('engagement rate divides by unique reach — never by impressions or views', () => {
    // 10 engagements from 4 reached accounts → 2.5, even with 100 impressions.
    const t = { ...emptyTotals(), reactions: 10, impressions: 100, views: 50, reach: 4 };
    expect(engagementRate(t)).toBeCloseTo(2.5);
  });

  it('returns null (not 0) when nothing was reached', () => {
    const t = { ...emptyTotals(), reactions: 5, reach: 0 };
    expect(engagementRate(t)).toBeNull();
  });
});

describe('series building', () => {
  it('sums daily rows into weekly buckets regardless of input order', () => {
    const rows = [
      { stat_date: '2026-08-20', views: 3 },
      { stat_date: '2026-08-17', views: 1 }, // Monday of the same week
      { stat_date: '2026-08-18', views: 2 },
      { stat_date: '2026-08-24', views: 5 }, // next week's Monday
    ];
    const series = bucketSeries(rows, 'week', (r) => ({ views: r.views }));
    expect(series).toEqual([
      { bucket: '2026-08-17', totals: expect.objectContaining({ views: 6 }) },
      { bucket: '2026-08-24', totals: expect.objectContaining({ views: 5 }) },
    ]);
  });

  it('merges month buckets and keeps buckets sorted', () => {
    const rows = [
      { stat_date: '2026-09-01', reactions: 1 },
      { stat_date: '2026-08-02', reactions: 2 },
      { stat_date: '2026-08-31', reactions: 4 },
    ];
    const series = bucketSeries(rows, 'month', (r) => ({ reactions: r.reactions }));
    expect(series.map((s) => s.bucket)).toEqual(['2026-08', '2026-09']);
    expect(series[0].totals.reactions).toBe(6);
  });

  it('adds totals independently per metric', () => {
    const a = { ...emptyTotals(), impressions: 1, reach: 2 };
    const b = { ...emptyTotals(), impressions: 3, reach: 4 };
    expect(addTotals(a, b)).toEqual({ ...emptyTotals(), impressions: 4, reach: 6 });
  });
});

describe('range validation', () => {
  it('accepts a normal inclusive range', () => {
    const parsed = parseRange('2026-08-01', '2026-08-07');
    expect(typeof parsed).toBe('object');
    if (typeof parsed !== 'string') {
      expect(parsed.from.toISOString()).toBe('2026-08-01T00:00:00.000Z');
      expect(parsed.to.toISOString()).toBe('2026-08-07T00:00:00.000Z');
    }
  });

  it('refuses bad formats, inverted ranges and oversized spans', () => {
    expect(typeof parseRange('20-08-2026', '2026-08-31')).toBe('string');
    expect(parseRange('2026-08-31', '2026-08-01')).toBe('from must be on or before to.');
    // 2026-01-01 → 2027-01-02 spans 367 days: one past the cap.
    expect(parseRange('2026-01-01', '2027-01-02')).toContain('limited to 366 days');
    // A range of exactly the cap is allowed.
    expect(typeof parseRange('2026-01-01', '2026-12-31')).toBe('object');
  });
});

describe('period comparison', () => {
  it('counts inclusive days', () => {
    expect(daysInRange('2026-06-01', '2026-06-01')).toBe(1);
    expect(daysInRange('2026-06-01', '2026-06-07')).toBe(7);
    // Across a month boundary.
    expect(daysInRange('2026-05-30', '2026-06-02')).toBe(4);
  });

  it('puts the previous window immediately before the range, same width', () => {
    // 7 days ending 2026-06-07 compares against the 7 days before 06-01.
    expect(previousRange('2026-06-01', '2026-06-07')).toEqual({
      from: '2026-05-25',
      to: '2026-05-31',
    });
    // A single day compares against the day before it.
    expect(previousRange('2026-06-01', '2026-06-01')).toEqual({
      from: '2026-05-31',
      to: '2026-05-31',
    });
  });

  it('never overlaps the current window', () => {
    const prev = previousRange('2026-06-10', '2026-06-20');
    expect(prev.to < '2026-06-10').toBe(true);
    // And the two spans are the same width, so the comparison is fair.
    expect(daysInRange(prev.from, prev.to)).toBe(daysInRange('2026-06-10', '2026-06-20'));
  });

  it('crosses a year boundary correctly', () => {
    expect(previousRange('2026-01-01', '2026-01-05')).toEqual({
      from: '2025-12-27',
      to: '2025-12-31',
    });
  });

  it('reports absolute and percentage change', () => {
    expect(changeOf(150, 100)).toEqual({
      current: 150,
      previous: 100,
      absolute: 50,
      percent: 0.5,
    });
    expect(changeOf(50, 100)).toEqual({
      current: 50,
      previous: 100,
      absolute: -50,
      percent: -0.5,
    });
  });

  it('returns a null percentage from a zero baseline, but keeps the absolute delta', () => {
    // Growth from nothing has no defined percentage. Rendering "+100%" or "∞"
    // for a creator's first week would be a lie.
    expect(changeOf(42, 0)).toEqual({
      current: 42,
      previous: 0,
      absolute: 42,
      percent: null,
    });
    // Zero to zero is still no signal, not 0% change.
    expect(changeOf(0, 0).percent).toBeNull();
  });

  it('reports a -100% drop to zero, which IS defined', () => {
    expect(changeOf(0, 80)).toEqual({
      current: 0,
      previous: 80,
      absolute: -80,
      percent: -1,
    });
  });
});

describe('completion rate', () => {
  it('is completes over starts', () => {
    expect(completionRate(10, 4)).toBe(0.4);
    expect(completionRate(3, 3)).toBe(1);
  });

  it('is null when nothing started, not 0%', () => {
    expect(completionRate(0, 0)).toBeNull();
    // Guard against a nonsensical negative denominator too.
    expect(completionRate(-1, 0)).toBeNull();
  });
});

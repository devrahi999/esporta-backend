import { AnalyticsReadService } from './analytics-read.service';
import type { SupabaseService } from '../supabase/supabase.service';

/**
 * Regression tests for the ARITHMETIC and SCOPING of the read layer.
 *
 * The original bugs these lock down were all the same mistake in different
 * places: treating a count of distinct ACCOUNTS as if it were additive. Reach
 * and active users cannot be summed out of daily rows — a viewer who returns
 * the next day is one account for the period but two daily rows. Fixtures
 * therefore give the daily rows a reach that is deliberately HIGHER than the
 * true distinct count, so a regression to summing fails loudly instead of
 * quietly inflating a dashboard.
 *
 * Part 3 moved ranking, pagination and platform aggregation into SQL
 * (`analytics_entity_top`, `analytics_identity_top`,
 * `analytics_platform_totals`). The tests below therefore also assert that the
 * service PUSHES DOWN order/limit/offset/kind rather than re-ranking in Node,
 * and that it passes the SQL reach through untouched.
 */

type Row = Record<string, unknown>;
type RpcFixture = Record<string, unknown | ((params: Record<string, unknown>) => unknown)>;

/** Rows the fake database returns, keyed by table. */
interface Fixture {
  tables: Record<string, Row[]>;
  rpc: RpcFixture;
}

/** Records every RPC call so a test can assert HOW the number was obtained. */
interface Calls {
  rpc: Array<{ fn: string; params: Record<string, unknown> }>;
}

/**
 * A chainable, thenable stand-in for a PostgREST query builder. Only the
 * operators the read service actually uses are implemented; the filters really
 * filter, because the service relies on them for scoping — and `gte`/`lte`/`lt`
 * really compare, so a range bug cannot pass by being ignored.
 */
class FakeBuilder implements PromiseLike<{ data: unknown; error: null; count: number | null }> {
  private readonly eqs: Array<[string, unknown]> = [];
  private readonly neqs: Array<[string, unknown]> = [];
  private readonly ins: Array<[string, unknown[]]> = [];
  private readonly isNulls: string[] = [];
  private readonly gtes: Array<[string, string]> = [];
  private readonly ltes: Array<[string, string]> = [];
  private readonly lts: Array<[string, string]> = [];
  private headOnly = false;

  constructor(private readonly rows: Row[]) {}

  select(_columns?: string, options?: { count?: string; head?: boolean }): this {
    if (options?.head) this.headOnly = true;
    return this;
  }
  order(): this {
    return this;
  }
  eq(column: string, value: unknown): this {
    this.eqs.push([column, value]);
    return this;
  }
  neq(column: string, value: unknown): this {
    this.neqs.push([column, value]);
    return this;
  }
  in(column: string, values: unknown[]): this {
    this.ins.push([column, values]);
    return this;
  }
  is(column: string, value: unknown): this {
    if (value === null) this.isNulls.push(column);
    return this;
  }
  gte(column: string, value: string): this {
    this.gtes.push([column, value]);
    return this;
  }
  lte(column: string, value: string): this {
    this.ltes.push([column, value]);
    return this;
  }
  lt(column: string, value: string): this {
    this.lts.push([column, value]);
    return this;
  }

  private filtered(): Row[] {
    return this.rows.filter(
      (row) =>
        this.eqs.every(([c, v]) => row[c] === v) &&
        this.neqs.every(([c, v]) => row[c] !== v) &&
        this.ins.every(([c, vs]) => vs.includes(row[c])) &&
        this.isNulls.every((c) => row[c] === null || row[c] === undefined) &&
        this.gtes.every(([c, v]) => String(row[c] ?? '') >= v) &&
        this.ltes.every(([c, v]) => String(row[c] ?? '') <= v) &&
        this.lts.every(([c, v]) => String(row[c] ?? '') < v),
    );
  }

  then<TResult1 = { data: unknown; error: null; count: number | null }, TResult2 = never>(
    onfulfilled?:
      | ((value: { data: unknown; error: null; count: number | null }) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    const rows = this.filtered();
    const payload = this.headOnly
      ? { data: null, error: null as null, count: rows.length }
      : { data: rows, error: null as null, count: null };
    return Promise.resolve(payload).then(onfulfilled, onrejected);
  }
}

function makeService(fixture: Fixture): { service: AnalyticsReadService; calls: Calls } {
  const calls: Calls = { rpc: [] };
  const supabase = {
    service: () => ({
      from: (table: string) => new FakeBuilder(fixture.tables[table] ?? []),
    }),
    rpcAsService: async (fn: string, params: Record<string, unknown>) => {
      calls.rpc.push({ fn, params });
      const entry = fixture.rpc[fn];
      return typeof entry === 'function'
        ? (entry as (p: Record<string, unknown>) => unknown)(params)
        : entry ?? [];
    },
  } as unknown as SupabaseService;

  return { service: new AnalyticsReadService(supabase), calls };
}

const RANGE = { from: '2026-06-01', to: '2026-06-02' } as const;
const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const POST_A = '33333333-3333-4333-8333-333333333333';
const POST_B = '44444444-4444-4444-8444-444444444444';

/** A daily entity row with sane defaults; only the interesting fields are passed. */
function entityRow(over: Row): Row {
  return {
    stat_date: '2026-06-01',
    entity_id: POST_A,
    owner_identity_id: ME,
    is_short: false,
    impressions: 0,
    views: 0,
    opens: 0,
    reactions: 0,
    comments: 0,
    shares: 0,
    saves: 0,
    reach_users: 0,
    recruitment_impressions: 0,
    recruitment_views: 0,
    watch_starts: 0,
    watch_25: 0,
    watch_50: 0,
    watch_75: 0,
    watch_completes: 0,
    watch_time_ms: 0,
    ...over,
  };
}

function identityRow(over: Row): Row {
  return {
    stat_date: '2026-06-01',
    identity_id: ME,
    profile_views: 0,
    followers_gained: 0,
    followers_lost: 0,
    applications_submitted: 0,
    hire_requests_made: 0,
    content_impressions: 0,
    content_views: 0,
    reach_users: 0,
    sessions: 0,
    events: 0,
    watch_starts: 0,
    watch_25: 0,
    watch_50: 0,
    watch_75: 0,
    watch_completes: 0,
    watch_time_ms: 0,
    ...over,
  };
}

/** A row shaped like `analytics_entity_top` output. */
function entityTopRow(over: Row): Row {
  return {
    entity_id: POST_A,
    is_short: false,
    owner_identity_id: ME,
    impressions: 0,
    views: 0,
    opens: 0,
    reactions: 0,
    comments: 0,
    shares: 0,
    saves: 0,
    watch_starts: 0,
    watch_25: 0,
    watch_50: 0,
    watch_75: 0,
    watch_completes: 0,
    watch_time_ms: 0,
    recruitment_impressions: 0,
    recruitment_views: 0,
    reach_users: 0,
    engagement: 0,
    total_count: 1,
    ...over,
  };
}

/** A row shaped like `analytics_identity_top` output. */
function identityTopRow(over: Row): Row {
  return {
    identity_id: ME,
    kind: 'personal',
    impressions: 0,
    views: 0,
    opens: 0,
    engagement: 0,
    watch_time_ms: 0,
    profile_views: 0,
    followers_gained: 0,
    followers_lost: 0,
    sessions: 0,
    events: 0,
    reach_users: 0,
    total_count: 1,
    ...over,
  };
}

/** A row shaped like `analytics_platform_totals` output. */
function platformRow(over: Row): Row {
  return {
    bucket: null,
    impressions: 0,
    views: 0,
    opens: 0,
    reactions: 0,
    comments: 0,
    shares: 0,
    saves: 0,
    engagement: 0,
    watch_starts: 0,
    watch_25: 0,
    watch_50: 0,
    watch_75: 0,
    watch_completes: 0,
    watch_time_ms: 0,
    profile_views: 0,
    followers_gained: 0,
    followers_lost: 0,
    sessions: 0,
    events: 0,
    follows_made: 0,
    unfollows_made: 0,
    applications_submitted: 0,
    hire_requests_made: 0,
    recruitment_impressions: 0,
    recruitment_views: 0,
    active_identities: 0,
    content_items: 0,
    ...over,
  };
}

/** A row shaped like `analytics_platform_growth` output. */
function growthRow(over: Row): Row {
  return { bucket: null, new_users: 0, new_teams: 0, new_posts: 0, new_shorts: 0, ...over };
}

/** A row shaped like `analytics_platform_size` output. */
function sizeRow(over: Row): Row {
  return {
    total_users: 0,
    total_teams: 0,
    total_posts: 0,
    total_shorts: 0,
    total_videos: 0,
    total_images: 0,
    ...over,
  };
}

describe('identity overview', () => {
  // Two days, the same two viewers each day. Summing reach_users gives 4;
  // the true distinct count is 2.
  const fixture: Fixture = {
    tables: {
      analytics_daily_entity: [
        entityRow({ stat_date: '2026-06-01', impressions: 10, views: 6, reactions: 2, reach_users: 2 }),
        entityRow({ stat_date: '2026-06-02', impressions: 5, views: 4, saves: 2, reach_users: 2 }),
      ],
      analytics_daily_identity: [
        identityRow({ stat_date: '2026-06-01', profile_views: 3, followers_gained: 4, followers_lost: 1, sessions: 2 }),
        identityRow({ stat_date: '2026-06-02', profile_views: 1, followers_gained: 1, sessions: 1 }),
      ],
    },
    rpc: { analytics_reach: [{ bucket: null, scope_id: null, reach_users: 2 }] },
  };

  it('takes reach from the distinct-count RPC, not the sum of daily rows', async () => {
    const { service, calls } = makeService(fixture);
    const result = (await service.overview(ME, { ...RANGE })) as {
      totals: { reach: number; impressions: number };
    };

    expect(result.totals.reach).toBe(2); // NOT 2 + 2
    expect(result.totals.impressions).toBe(15); // additive metrics still sum
    expect(calls.rpc.some((c) => c.fn === 'analytics_reach')).toBe(true);
  });

  it('scopes the reach RPC to the active identity so a team dashboard cannot read another', async () => {
    const { service, calls } = makeService(fixture);
    await service.overview(ME, { ...RANGE });

    const reachCall = calls.rpc.find((c) => c.fn === 'analytics_reach');
    expect(reachCall?.params.p_scope).toBe('identity');
    expect(reachCall?.params.p_scope_ids).toEqual([ME]);
    expect(reachCall?.params.p_from).toBe('2026-06-01');
    expect(reachCall?.params.p_to).toBe('2026-06-02');
  });

  it('divides engagement by distinct reach — the documented denominator', async () => {
    const { service } = makeService(fixture);
    const result = (await service.overview(ME, { ...RANGE })) as {
      totals: { engagement: number; engagement_rate: number | null };
    };

    // reactions 2 + saves 2 = 4 engagement over reach 2.
    expect(result.totals.engagement).toBe(4);
    expect(result.totals.engagement_rate).toBe(2);
  });

  it('reports zero reach and a null rate rather than dividing by a summed zero', async () => {
    const { service } = makeService({
      tables: fixture.tables,
      rpc: { analytics_reach: [] },
    });
    const result = (await service.overview(ME, { ...RANGE })) as {
      totals: { reach: number; engagement_rate: number | null };
    };

    expect(result.totals.reach).toBe(0);
    expect(result.totals.engagement_rate).toBeNull();
  });

  it('surfaces recruitment impressions and views from the owned content', async () => {
    const { service } = makeService({
      tables: {
        analytics_daily_entity: [entityRow({ recruitment_impressions: 7, recruitment_views: 3 })],
        analytics_daily_identity: [identityRow({ applications_submitted: 2, hire_requests_made: 1 })],
      },
      rpc: { analytics_reach: [{ bucket: null, scope_id: null, reach_users: 1 }] },
    });
    const result = (await service.overview(ME, { ...RANGE })) as {
      recruitment: Record<string, number>;
    };

    expect(result.recruitment).toEqual({
      applications_submitted: 2,
      hire_requests_made: 1,
      impressions: 7,
      views: 3,
    });
  });

  it('builds the reach series from per-bucket distinct counts', async () => {
    const { service, calls } = makeService({
      tables: fixture.tables,
      rpc: {
        analytics_reach: [
          { bucket: '2026-06-02', scope_id: null, reach_users: 2 },
          { bucket: '2026-06-01', scope_id: null, reach_users: 2 },
        ],
      },
    });
    const result = (await service.overview(ME, { ...RANGE, granularity: 'week' })) as {
      series: { reach: Array<{ bucket: string; value: number }> };
    };

    // Sorted, and each bucket keeps its own distinct count.
    expect(result.series.reach).toEqual([
      { bucket: '2026-06-01', value: 2 },
      { bucket: '2026-06-02', value: 2 },
    ]);
    // The granularity is pushed down to SQL, not applied by re-summing here.
    expect(calls.rpc.filter((c) => c.fn === 'analytics_reach').map((c) => c.params.p_granularity)).toContain(
      'week',
    );
  });

  it('derives the watch completion rate instead of leaving it to the client', async () => {
    const { service } = makeService({
      tables: {
        analytics_daily_entity: [entityRow({})],
        analytics_daily_identity: [identityRow({ watch_starts: 8, watch_completes: 2, watch_time_ms: 5000 })],
      },
      rpc: { analytics_reach: [{ bucket: null, scope_id: null, reach_users: 1 }] },
    });
    const result = (await service.overview(ME, { ...RANGE })) as {
      watch: { starts: number; completes: number; completion_rate: number | null };
    };

    expect(result.watch.starts).toBe(8);
    expect(result.watch.completion_rate).toBe(0.25);
  });

  it('returns a null completion rate when nothing started, not 0%', async () => {
    const { service } = makeService({
      tables: {
        analytics_daily_entity: [entityRow({})],
        analytics_daily_identity: [identityRow({})],
      },
      rpc: { analytics_reach: [] },
    });
    const result = (await service.overview(ME, { ...RANGE })) as {
      watch: { completion_rate: number | null };
    };

    expect(result.watch.completion_rate).toBeNull();
  });

  it('omits the comparison block entirely unless compare is requested', async () => {
    const { service } = makeService(fixture);
    const result = (await service.overview(ME, { ...RANGE })) as Record<string, unknown>;

    expect(result.previous).toBeUndefined();
    expect(result.changes).toBeUndefined();
  });
});

describe('identity overview — period comparison', () => {
  /**
   * The current window is 2026-06-01..02, so the previous window must be the
   * equal-length span immediately before it: 2026-05-30..31. The fixture gives
   * the two windows different numbers, and the fake `gte`/`lte` really filter,
   * so a wrong previous range shows up as a wrong delta.
   */
  const fixture: Fixture = {
    tables: {
      analytics_daily_entity: [
        entityRow({ stat_date: '2026-06-01', views: 10, impressions: 20, reactions: 4 }),
        entityRow({ stat_date: '2026-05-31', views: 5, impressions: 10, reactions: 1 }),
      ],
      analytics_daily_identity: [
        identityRow({ stat_date: '2026-06-01', profile_views: 6, followers_gained: 3 }),
        identityRow({ stat_date: '2026-05-31', profile_views: 2, followers_gained: 1 }),
      ],
    },
    rpc: {
      analytics_reach: (p: Record<string, unknown>) => [
        { bucket: null, scope_id: null, reach_users: p.p_from === '2026-06-01' ? 8 : 4 },
      ],
    },
  };

  it('compares against the equal-length window immediately before the range', async () => {
    const { service, calls } = makeService(fixture);
    const result = (await service.overview(ME, { ...RANGE, compare: true })) as {
      previous: { scope: { from: string; to: string }; totals: { views: number } };
    };

    expect(result.previous.scope).toEqual({ from: '2026-05-30', to: '2026-05-31' });
    expect(result.previous.totals.views).toBe(5);
    // The previous window is fetched with its own range, not the current one.
    expect(calls.rpc.some((c) => c.fn === 'analytics_reach' && c.params.p_from === '2026-05-30')).toBe(true);
  });

  it('reports absolute and percentage change for each card metric', async () => {
    const { service } = makeService(fixture);
    const result = (await service.overview(ME, { ...RANGE, compare: true })) as {
      changes: Record<string, { current: number; previous: number; absolute: number; percent: number | null }>;
    };

    expect(result.changes.views).toEqual({ current: 10, previous: 5, absolute: 5, percent: 1 });
    expect(result.changes.reach).toEqual({ current: 8, previous: 4, absolute: 4, percent: 1 });
    expect(result.changes.profile_views).toEqual({ current: 6, previous: 2, absolute: 4, percent: 2 });
  });

  it('returns a NULL percentage when the previous period was zero', async () => {
    const { service } = makeService({
      tables: {
        // Nothing at all in the previous window.
        analytics_daily_entity: [entityRow({ stat_date: '2026-06-01', views: 7 })],
        analytics_daily_identity: [identityRow({ stat_date: '2026-06-01', profile_views: 3 })],
      },
      rpc: { analytics_reach: [] },
    });
    const result = (await service.overview(ME, { ...RANGE, compare: true })) as {
      changes: Record<string, { absolute: number; percent: number | null }>;
    };

    // Growth from nothing has no defined percentage; the absolute delta still does.
    expect(result.changes.views.percent).toBeNull();
    expect(result.changes.views.absolute).toBe(7);
    expect(result.changes.profile_views.percent).toBeNull();
  });
});

describe('top content', () => {
  const fixture: Fixture = {
    tables: {
      posts: [{ id: POST_A, type_id: 'normal', caption: 'A', deleted_at: null }],
    },
    rpc: {
      analytics_entity_top: [
        entityTopRow({ entity_id: POST_A, views: 10, reach_users: 3, reactions: 2, total_count: 2 }),
        entityTopRow({ entity_id: POST_B, views: 2, reach_users: 1, total_count: 2 }),
      ],
    },
  };

  it('passes the SQL reach through untouched instead of summing daily rows', async () => {
    const { service } = makeService(fixture);
    const result = (await service.topContent(ME, { ...RANGE })) as {
      items: Array<{ entity_id: string; totals: { views: number; reach: number } }>;
    };

    const a = result.items.find((i) => i.entity_id === POST_A);
    expect(a?.totals.views).toBe(10);
    expect(a?.totals.reach).toBe(3); // exact distinct count from SQL
  });

  it('scopes the SQL leaderboard to the active identity', async () => {
    const { service, calls } = makeService(fixture);
    await service.topContent(ME, { ...RANGE });

    const call = calls.rpc.find((c) => c.fn === 'analytics_entity_top');
    expect(call?.params.p_owner).toBe(ME);
  });

  it('pushes order, kind, limit and offset down to SQL rather than ranking in Node', async () => {
    const { service, calls } = makeService(fixture);
    await service.topContent(ME, { ...RANGE, kind: 'short', order: 'reach', limit: 5, offset: 10 });

    const call = calls.rpc.find((c) => c.fn === 'analytics_entity_top');
    expect(call?.params).toMatchObject({
      p_owner: ME,
      p_kind: 'short',
      p_order: 'reach',
      p_limit: 5,
      p_offset: 10,
    });
  });

  it('keeps SQL row order and attaches the post row it fetched', async () => {
    const { service } = makeService(fixture);
    const result = (await service.topContent(ME, { ...RANGE })) as {
      items: Array<{ entity_id: string; post: Row | null }>;
      total: number;
    };

    expect(result.items.map((i) => i.entity_id)).toEqual([POST_A, POST_B]);
    expect((result.items[0].post as Row)?.caption).toBe('A');
    // POST_B has no posts row (hard-deleted): metrics survive, display is null.
    expect(result.items[1].post).toBeNull();
    // total_count travels out for pagination.
    expect(result.total).toBe(2);
  });

  it('exposes the watch funnel and its derived completion rate per item', async () => {
    const { service } = makeService({
      tables: { posts: [] },
      rpc: {
        analytics_entity_top: [
          entityTopRow({ is_short: true, watch_starts: 10, watch_completes: 4, watch_time_ms: 90_000 }),
        ],
      },
    });
    const result = (await service.topContent(ME, { ...RANGE, kind: 'short' })) as {
      items: Array<{ is_short: boolean; watch: { completes: number; completion_rate: number | null } }>;
    };

    expect(result.items[0].is_short).toBe(true);
    expect(result.items[0].watch.completes).toBe(4);
    expect(result.items[0].watch.completion_rate).toBe(0.4);
  });

  it('returns an empty result without fetching display rows', async () => {
    const { service } = makeService({ tables: {}, rpc: { analytics_entity_top: [] } });
    const result = (await service.topContent(ME, { ...RANGE })) as {
      items: unknown[];
      total: number;
    };

    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('does not leak owner identity rows on the identity-scoped surface', async () => {
    const { service } = makeService(fixture);
    const result = (await service.topContent(ME, { ...RANGE })) as {
      identities: Record<string, unknown>;
      items: Array<{ identity: unknown }>;
    };

    // The dashboard already knows whose content it is; no identity lookup runs.
    expect(result.identities).toEqual({});
    expect(result.items[0].identity).toBeNull();
  });
});

describe('content detail', () => {
  it('answers 404 — not 403 — for content the identity does not own', async () => {
    const { service } = makeService({
      tables: {
        analytics_daily_entity: [entityRow({ entity_id: POST_A, owner_identity_id: OTHER, views: 3 })],
      },
      rpc: {},
    });

    await expect(service.contentDetail(ME, POST_A, { ...RANGE })).rejects.toMatchObject({
      status: 404,
    });
  });

  it('answers 404 when ownership is no longer resolvable (hard-deleted post)', async () => {
    const { service } = makeService({
      tables: {
        analytics_daily_entity: [entityRow({ entity_id: POST_A, owner_identity_id: null, views: 3 })],
      },
      rpc: {},
    });

    await expect(service.contentDetail(ME, POST_A, { ...RANGE })).rejects.toMatchObject({
      status: 404,
    });
  });

  it('answers 404 when there is no data at all in the range', async () => {
    const { service } = makeService({ tables: { analytics_daily_entity: [] }, rpc: {} });

    await expect(service.contentDetail(ME, POST_A, { ...RANGE })).rejects.toMatchObject({
      status: 404,
    });
  });

  it('rejects a non-uuid entity id before querying', async () => {
    const { service, calls } = makeService({ tables: {}, rpc: {} });

    await expect(service.contentDetail(ME, 'not-a-uuid', { ...RANGE })).rejects.toMatchObject({
      status: 400,
    });
    expect(calls.rpc).toHaveLength(0);
  });

  it('uses the exact entity reach for the owner-facing detail', async () => {
    const { service, calls } = makeService({
      tables: {
        analytics_daily_entity: [
          entityRow({ entity_id: POST_A, stat_date: '2026-06-01', views: 4, reactions: 1, reach_users: 2 }),
          entityRow({ entity_id: POST_A, stat_date: '2026-06-02', views: 4, reactions: 1, reach_users: 2 }),
        ],
      },
      rpc: { analytics_reach: [{ bucket: null, scope_id: null, reach_users: 2 }] },
    });
    const result = (await service.contentDetail(ME, POST_A, { ...RANGE })) as {
      totals: { views: number; reach: number; engagement_rate: number | null };
    };

    expect(result.totals.views).toBe(8);
    expect(result.totals.reach).toBe(2); // NOT 4
    expect(result.totals.engagement_rate).toBe(1); // engagement 2 / reach 2
    expect(calls.rpc.find((c) => c.fn === 'analytics_reach')?.params.p_scope).toBe('entity');
  });

  it('lets an admin read content it does not own, unlike the identity route', async () => {
    const tables = {
      analytics_daily_entity: [entityRow({ entity_id: POST_A, owner_identity_id: OTHER, views: 3 })],
    };
    const rpc = { analytics_reach: [{ bucket: null, scope_id: null, reach_users: 2 }] };

    const owner = makeService({ tables, rpc });
    await expect(owner.service.contentDetail(ME, POST_A, { ...RANGE })).rejects.toMatchObject({
      status: 404,
    });

    const admin = makeService({ tables, rpc });
    const result = (await admin.service.adminContentDetail(POST_A, { ...RANGE })) as {
      totals: { views: number };
      owner_identity_id: string | null;
    };
    expect(result.totals.views).toBe(3);
    expect(result.owner_identity_id).toBe(OTHER);
  });
});

describe('admin overview', () => {
  const fixture: Fixture = {
    tables: {
      identities: [
        { id: ME, kind: 'personal', status: 'active' },
        { id: OTHER, kind: 'team', status: 'active' },
        { id: POST_B, kind: 'personal', status: 'deleted' },
      ],
      posts: [
        { id: POST_A, type_id: 'normal', created_at: '2026-06-01T10:00:00Z', deleted_at: null },
        { id: POST_B, type_id: 'short', created_at: '2026-06-02T10:00:00Z', deleted_at: null },
      ],
    },
    rpc: {
      // Bucketed series source. The period total comes from analytics_audience,
      // which computes the same distinct count.
      analytics_active_users: [{ bucket: null, active_users: 1 }],
      analytics_audience: [{ active_users: 1, returning_users: 1, new_users: 0 }],
      analytics_reach: [{ bucket: null, scope_id: null, reach_users: 3 }],
      analytics_platform_totals: [
        platformRow({
          impressions: 14,
          views: 7,
          engagement: 5,
          reactions: 2,
          comments: 1,
          shares: 1,
          saves: 1,
          profile_views: 3,
          sessions: 3,
          events: 25,
          active_identities: 2,
          content_items: 2,
          follows_made: 4,
          unfollows_made: 1,
        }),
      ],
      analytics_platform_growth: [growthRow({ new_users: 2, new_teams: 1, new_posts: 1, new_shorts: 1 })],
      analytics_platform_size: [
        sizeRow({ total_users: 1, total_teams: 1, total_posts: 1, total_shorts: 1, total_videos: 1 }),
      ],
    },
  };

  it('counts active users as distinct accounts, not summed identity-days', async () => {
    const { service, calls } = makeService(fixture);
    const result = (await service.adminOverview({ ...RANGE })) as {
      totals: {
        active_users: number;
        active_identities: number;
        sessions: number;
        reach: number;
        impressions: number;
      };
    };

    expect(result.totals.active_users).toBe(1); // NOT 2, and never active_identities
    expect(result.totals.active_identities).toBe(2); // a distinct count in its own right
    expect(result.totals.sessions).toBe(3); // sessions are additive
    expect(result.totals.reach).toBe(3); // NOT 3 + 3
    expect(result.totals.impressions).toBe(14);
    // The distinct totals are resolved in SQL, never folded out of daily rows.
    expect(calls.rpc.some((c) => c.fn === 'analytics_audience')).toBe(true);
    expect(calls.rpc.some((c) => c.fn === 'analytics_reach')).toBe(true);
  });

  it('splits the audience into returning and first-seen accounts', async () => {
    const { service } = makeService(fixture);
    const result = (await service.adminOverview({ ...RANGE })) as {
      totals: { active_users: number; returning_users: number; first_seen_users: number };
      derived: { returning_user_rate: number | null };
    };

    // active = returning + first-seen, by construction in SQL.
    expect(result.totals.returning_users + result.totals.first_seen_users).toBe(
      result.totals.active_users,
    );
    expect(result.derived.returning_user_rate).toBe(1);
  });

  it('aggregates platform totals in SQL rather than summing shipped rows', async () => {
    const { service, calls } = makeService(fixture);
    await service.adminOverview({ ...RANGE, granularity: 'month' });

    const grans = calls.rpc
      .filter((c) => c.fn === 'analytics_platform_totals')
      .map((c) => c.params.p_granularity);
    // One 'total' call for the cards, one bucketed call for the series.
    expect(grans).toContain('total');
    expect(grans).toContain('month');
  });

  it('asks for platform scope by passing no scope ids', async () => {
    const { service, calls } = makeService(fixture);
    await service.adminOverview({ ...RANGE });

    const reachCall = calls.rpc.find((c) => c.fn === 'analytics_reach');
    expect(reachCall?.params.p_scope_ids).toBeNull();
  });

  it('separates all-time platform size from range-scoped activity', async () => {
    const { service } = makeService(fixture);
    const result = (await service.adminOverview({ ...RANGE })) as {
      platform: { total_users: number; total_teams: number; total_posts: number; total_videos: number };
      totals: {
        active_users: number;
        new_users: number;
        posts_published: number;
        shorts_published: number;
      };
      changes?: Record<string, unknown>;
    };

    // All-time composition lives under `platform`, never inside `totals`.
    expect(result.platform.total_users).toBe(1);
    expect(result.platform.total_teams).toBe(1);
    expect(result.platform.total_videos).toBe(1);
    expect((result.totals as Record<string, unknown>).total_users).toBeUndefined();

    // Range-scoped signups and publishing volume, split by kind.
    expect(result.totals.new_users).toBe(2);
    expect(result.totals.posts_published).toBe(1);
    expect(result.totals.shorts_published).toBe(1);
    // And none of it is confused with "users active in the period".
    expect(result.totals.active_users).toBe(1);
  });

  it('keeps reach, impressions and views as three separate numbers', async () => {
    const { service } = makeService(fixture);
    const result = (await service.adminOverview({ ...RANGE })) as {
      totals: { reach: number; impressions: number; views: number };
      derived: { views_per_reach: number | null; impressions_per_reach: number | null };
    };

    expect(result.totals.impressions).toBe(14);
    expect(result.totals.views).toBe(7);
    expect(result.totals.reach).toBe(3);
    // Ratios are offered, but only as ratios — never collapsing the three.
    expect(result.derived.views_per_reach).toBeCloseTo(7 / 3);
    expect(result.derived.impressions_per_reach).toBeCloseTo(14 / 3);
  });

  it('derives averages server-side and returns null at a zero denominator', async () => {
    const { service } = makeService(fixture);
    const result = (await service.adminOverview({ ...RANGE })) as {
      derived: {
        avg_views_per_content: number | null;
        avg_events_per_session: number | null;
        avg_watch_time_ms: number | null;
        completion_rate: number | null;
      };
    };

    expect(result.derived.avg_views_per_content).toBeCloseTo(7 / 2); // views ÷ content items
    expect(result.derived.avg_events_per_session).toBeCloseTo(25 / 3);
    // No watch activity in the fixture: "no signal" is null, not 0.
    expect(result.derived.avg_watch_time_ms).toBeNull();
    expect(result.derived.completion_rate).toBeNull();
  });

  it('exposes the engagement components and follow actions separately', async () => {
    const { service } = makeService(fixture);
    const result = (await service.adminOverview({ ...RANGE })) as {
      totals: { reactions: number; comments: number; shares: number; saves: number; engagement: number };
      follow_actions: { follows: number; unfollows: number; net: number };
    };

    expect(result.totals.reactions).toBe(2);
    expect(result.totals.comments).toBe(1);
    expect(result.totals.shares).toBe(1);
    expect(result.totals.saves).toBe(1);
    // engagement is the sum of the four, computed from the same row.
    expect(result.totals.engagement).toBe(5);
    expect(result.follow_actions).toEqual({ follows: 4, unfollows: 1, net: 3 });
  });

  it('compares against the preceding window when asked', async () => {
    const { service } = makeService({
      tables: fixture.tables,
      rpc: {
        ...fixture.rpc,
        analytics_platform_totals: (p: Record<string, unknown>) => [
          platformRow({ impressions: p.p_from === '2026-06-01' ? 14 : 7, sessions: 3 }),
        ],
        analytics_audience: (p: Record<string, unknown>) => [
          p.p_from === '2026-06-01'
            ? { active_users: 4, returning_users: 3, new_users: 1 }
            : { active_users: 2, returning_users: 2, new_users: 0 },
        ],
      },
    });
    const result = (await service.adminOverview({ ...RANGE, compare: true })) as {
      previous: { scope: { from: string; to: string }; totals: { impressions: number } };
      changes: Record<string, { percent: number | null; absolute: number }>;
    };

    expect(result.previous.scope).toEqual({ from: '2026-05-30', to: '2026-05-31' });
    expect(result.previous.totals.impressions).toBe(7);
    expect(result.changes.impressions.percent).toBe(1);
    expect(result.changes.active_users.percent).toBe(1);
    // A rate has no meaningful percentage change and must not get one.
    expect(result.changes.engagement_rate).toBeUndefined();
  });

  it('never reports a percentage change against a zero baseline', async () => {
    const { service } = makeService({
      tables: fixture.tables,
      rpc: {
        ...fixture.rpc,
        analytics_platform_totals: (p: Record<string, unknown>) => [
          platformRow({ impressions: p.p_from === '2026-06-01' ? 9 : 0 }),
        ],
      },
    });
    const result = (await service.adminOverview({ ...RANGE, compare: true })) as {
      changes: Record<string, { percent: number | null; absolute: number }>;
    };

    // Growth from nothing has no percentage; the absolute delta still does.
    expect(result.changes.impressions.percent).toBeNull();
    expect(result.changes.impressions.absolute).toBe(9);
  });
});

describe('admin freshness', () => {
  it('reports the aggregate mode and flags a layer that has fallen behind', async () => {
    const { service } = makeService({
      tables: {},
      rpc: {
        analytics_freshness: [
          { layer: 'entity', last_stat_date: '2026-01-01', last_computed_at: '2026-01-02T00:15:00Z', rows_total: 5 },
          { layer: 'identity', last_stat_date: '2026-01-01', last_computed_at: '2026-01-02T00:16:00Z', rows_total: 3 },
        ],
      },
    });
    const result = (await service.adminFreshness()) as {
      mode: string;
      last_processed_at: string | null;
      last_complete_day: string | null;
      stale: boolean;
    };

    // The console must never imply these numbers are live.
    expect(result.mode).toBe('daily_aggregate');
    expect(result.last_processed_at).toBe('2026-01-02T00:16:00Z');
    expect(result.last_complete_day).toBe('2026-01-01');
    expect(result.stale).toBe(true); // a 2026-01-01 day is far behind "yesterday"
  });

  it('reports an empty analytics layer as stale rather than as fresh zeroes', async () => {
    const { service } = makeService({
      tables: {},
      rpc: {
        analytics_freshness: [
          { layer: 'entity', last_stat_date: null, last_computed_at: null, rows_total: 0 },
        ],
      },
    });
    const result = (await service.adminFreshness()) as { stale: boolean; last_complete_day: null };

    expect(result.last_complete_day).toBeNull();
    expect(result.stale).toBe(true);
  });
});

describe('admin reaction mix', () => {
  it('names its source so it is not mistaken for the rollup reaction count', async () => {
    const { service, calls } = makeService({
      tables: {},
      rpc: {
        analytics_reaction_mix: [
          { type_id: 'love', label: 'Love', emoji: '❤️', sort_order: 1, reactions: 4 },
          { type_id: 'fire', label: 'Fire', emoji: null, sort_order: 2, reactions: 0 },
        ],
      },
    });
    const result = (await service.adminReactionMix({ ...RANGE })) as {
      scope: { source: string; entity_id: string | null; identity_id: string | null };
      items: Array<{ type_id: string; reactions: number; emoji: string | null }>;
    };

    expect(result.scope.source).toBe('reactions_standing');
    expect(result.scope.entity_id).toBeNull();
    // Unused reaction types are kept, so a mix chart never has a missing slice.
    expect(result.items.map((i) => i.type_id)).toEqual(['love', 'fire']);
    expect(result.items[1].reactions).toBe(0);
    expect(calls.rpc[0].params).toMatchObject({ p_entity: null, p_owner: null });
  });

  it('passes an entity or identity scope down to SQL', async () => {
    const { service, calls } = makeService({ tables: {}, rpc: { analytics_reaction_mix: [] } });
    await service.adminReactionMix({ ...RANGE, entityId: POST_A, identityId: ME });

    expect(calls.rpc[0].params).toMatchObject({ p_entity: POST_A, p_owner: ME });
  });

  it('refuses a malformed scope id instead of querying with it', async () => {
    const { service } = makeService({ tables: {}, rpc: { analytics_reaction_mix: [] } });
    await expect(service.adminReactionMix({ ...RANGE, entityId: 'not-a-uuid' })).rejects.toThrow(
      /uuid/i,
    );
  });
});

describe('admin content distribution', () => {
  it('groups the flat SQL rows by dimension and labels the basis', async () => {
    const { service } = makeService({
      tables: {},
      rpc: {
        analytics_content_distribution: [
          { dimension: 'format', key: 'post', label: 'Posts', items: 8 },
          { dimension: 'format', key: 'short', label: 'Shorts', items: 2 },
          { dimension: 'author', key: 'personal', label: 'Personal', items: 9 },
          { dimension: 'author', key: 'team', label: 'Teams', items: 1 },
        ],
      },
    });
    const result = (await service.adminContentDistribution({ ...RANGE })) as {
      scope: { basis: string };
      dimensions: Record<string, Array<{ key: string; items: number }>>;
    };

    // Publication counts, not traffic — the payload says which.
    expect(result.scope.basis).toBe('published_at');
    expect(result.dimensions.format).toHaveLength(2);
    // Each dimension partitions the same set, so both sum to the same total.
    const sum = (rows: Array<{ items: number }>) => rows.reduce((s, r) => s + r.items, 0);
    expect(sum(result.dimensions.format)).toBe(sum(result.dimensions.author));
  });
});

describe('admin identity detail', () => {
  const IDENTITY_FIXTURE: Fixture = {
    tables: {
      identities: [{ id: ME, kind: 'personal', status: 'active', username: 'ace', verified: true }],
      analytics_daily_identity: [
        identityRow({ stat_date: '2026-06-01', profile_views: 5, followers_gained: 3, followers_lost: 1 }),
      ],
      analytics_daily_entity: [
        entityRow({ stat_date: '2026-06-01', entity_id: POST_A, impressions: 10, views: 6, reactions: 2 }),
        entityRow({ stat_date: '2026-06-02', entity_id: POST_B, impressions: 4, views: 2, comments: 1 }),
      ],
      posts: [],
      media: [],
      recruitments: [],
    },
    rpc: {
      analytics_reach: [{ bucket: null, scope_id: ME, reach_users: 4 }],
      analytics_reaction_mix: [{ type_id: 'love', label: 'Love', emoji: null, sort_order: 1, reactions: 2 }],
      analytics_entity_top: [],
    },
  };

  it('answers with the identity, its own content metrics and its reaction mix', async () => {
    const { service } = makeService(IDENTITY_FIXTURE);
    const result = (await service.adminIdentityDetail(ME, { ...RANGE })) as {
      identity: { username: string };
      kind: string;
      totals: { impressions: number; views: number; reach: number };
      followers: { net: number };
      derived: { content_items: number; avg_views_per_content: number | null };
      reaction_mix: Array<{ type_id: string }>;
    };

    expect(result.identity.username).toBe('ace');
    expect(result.kind).toBe('personal');
    expect(result.totals.impressions).toBe(14);
    expect(result.totals.views).toBe(8);
    // Reach is the SQL distinct count, not the sum of the two daily rows.
    expect(result.totals.reach).toBe(4);
    expect(result.followers.net).toBe(2);
    expect(result.derived.content_items).toBe(2);
    expect(result.derived.avg_views_per_content).toBe(4);
    expect(result.reaction_mix[0].type_id).toBe('love');
  });

  it('scopes every read to the identity in the route', async () => {
    const { service, calls } = makeService(IDENTITY_FIXTURE);
    await service.adminIdentityDetail(ME, { ...RANGE });

    const reach = calls.rpc.find((c) => c.fn === 'analytics_reach');
    expect(reach?.params.p_scope_ids).toEqual([ME]);
    // The identity's own leaderboards are owner-scoped in SQL.
    for (const call of calls.rpc.filter((c) => c.fn === 'analytics_entity_top')) {
      expect(call.params.p_owner).toBe(ME);
    }
  });

  it('answers 404 for an identity that does not exist', async () => {
    const { service } = makeService({ tables: { identities: [] }, rpc: {} });
    await expect(service.adminIdentityDetail(OTHER, { ...RANGE })).rejects.toThrow(/no such identity/i);
  });

  it('refuses a malformed identity id', async () => {
    const { service } = makeService({ tables: { identities: [] }, rpc: {} });
    await expect(service.adminIdentityDetail('nope', { ...RANGE })).rejects.toThrow(/uuid/i);
  });
});

describe('admin top identities', () => {
  it('orders in SQL and returns identity type plus display fields', async () => {
    const { service, calls } = makeService({
      tables: {
        identities: [
          { id: OTHER, kind: 'team', username: 'teamx', display_name: 'Team X', avatar_url: null, verified: true, status: 'active' },
          { id: ME, kind: 'personal', username: 'me', display_name: 'Me', avatar_url: null, verified: false, status: 'active' },
        ],
      },
      rpc: {
        analytics_identity_top: [
          identityTopRow({ identity_id: OTHER, kind: 'team', reach_users: 9, views: 10, engagement: 3, total_count: 2 }),
          identityTopRow({ identity_id: ME, kind: 'personal', reach_users: 2, followers_gained: 5, total_count: 2 }),
        ],
      },
    });
    const result = (await service.adminTopIdentities({ ...RANGE, limit: 2 })) as {
      items: Array<{
        identity_id: string;
        kind: string;
        reach: number;
        views: number;
        engagement_rate: number | null;
        followers: { gained: number };
        identity: Row | null;
      }>;
      total: number;
    };

    expect(result.items.map((i) => i.identity_id)).toEqual([OTHER, ME]);
    expect(result.items[0].kind).toBe('team');
    expect(result.items[0].reach).toBe(9);
    expect(result.items[0].views).toBe(10);
    // engagement 3 over reach 9.
    expect(result.items[0].engagement_rate).toBeCloseTo(1 / 3);
    expect((result.items[0].identity as Row)?.display_name).toBe('Team X');
    expect(result.items[1].kind).toBe('personal');
    expect(result.items[1].followers.gained).toBe(5);
    expect(result.total).toBe(2);
    expect(calls.rpc.find((c) => c.fn === 'analytics_identity_top')?.params.p_limit).toBe(2);
  });

  it('pushes the identity-type filter, order and offset down to SQL', async () => {
    const { service, calls } = makeService({ tables: {}, rpc: { analytics_identity_top: [] } });
    await service.adminTopIdentities({ ...RANGE, identityType: 'team', order: 'engagement', offset: 20 });

    expect(calls.rpc.find((c) => c.fn === 'analytics_identity_top')?.params).toMatchObject({
      p_kind: 'team',
      p_order: 'engagement',
      p_offset: 20,
    });
  });

  it('returns a null engagement rate at zero reach rather than a fake zero', async () => {
    const { service } = makeService({
      tables: { identities: [] },
      rpc: { analytics_identity_top: [identityTopRow({ reach_users: 0, engagement: 0 })] },
    });
    const result = (await service.adminTopIdentities({ ...RANGE })) as {
      items: Array<{ engagement_rate: number | null }>;
    };

    expect(result.items[0].engagement_rate).toBeNull();
  });

  it('returns an empty list without a follow-up query when nothing was reached', async () => {
    const { service, calls } = makeService({
      tables: { analytics_daily_identity: [] },
      rpc: { analytics_identity_top: [] },
    });
    const result = (await service.adminTopIdentities({ ...RANGE })) as { items: unknown[] };

    expect(result.items).toEqual([]);
    expect(calls.rpc).toHaveLength(1);
  });
});

describe('admin top content', () => {
  it('reads platform-wide by passing a null owner, and attaches the owning identity', async () => {
    const { service, calls } = makeService({
      tables: {
        posts: [{ id: POST_A, type_id: 'short', caption: 'clip', deleted_at: null, author_id: OTHER }],
        identities: [
          { id: OTHER, kind: 'team', username: 'teamx', display_name: 'Team X', avatar_url: null, verified: true, status: 'active' },
        ],
      },
      rpc: {
        analytics_entity_top: [
          entityTopRow({ entity_id: POST_A, owner_identity_id: OTHER, is_short: true, views: 50, reach_users: 30 }),
        ],
      },
    });
    const result = (await service.adminTopContent({ ...RANGE, kind: 'short' })) as {
      items: Array<{ owner_identity_id: string | null; identity: Row | null; totals: { reach: number } }>;
    };

    // Null owner => no identity scoping, i.e. the whole platform.
    expect(calls.rpc.find((c) => c.fn === 'analytics_entity_top')?.params.p_owner).toBeNull();
    expect(result.items[0].owner_identity_id).toBe(OTHER);
    expect((result.items[0].identity as Row)?.display_name).toBe('Team X');
    expect(result.items[0].totals.reach).toBe(30);
  });
});

describe('range validation', () => {
  it('refuses an inverted range before any query runs', async () => {
    const { service, calls } = makeService({ tables: {}, rpc: {} });

    await expect(
      service.overview(ME, { from: '2026-06-10', to: '2026-06-01' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(calls.rpc).toHaveLength(0);
  });

  it('refuses a span longer than the documented cap', async () => {
    const { service } = makeService({ tables: {}, rpc: {} });

    await expect(
      service.overview(ME, { from: '2025-01-01', to: '2026-12-31' }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

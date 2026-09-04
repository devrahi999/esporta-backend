import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { AppException } from '../common/errors/app-exception';
import { isUuid } from '../common/utils/uuid';
import {
  addTotals,
  bucketSeries,
  changeOf,
  completionRate,
  emptyTotals,
  engagementOf,
  engagementRate,
  parseRange,
  previousRange,
  ratioOf,
  type Granularity,
  type MetricChange,
  type MetricTotals,
} from './analytics-metrics';
import type {
  AnalyticsOverviewQueryDto,
  AnalyticsQueryDto,
  AnalyticsReactionMixQueryDto,
  AnalyticsTopContentQueryDto,
  AnalyticsTopIdentitiesQueryDto,
} from './dto/analytics-query.dto';

/**
 * Dashboard reads over the daily rollups (Part 2 data contracts, Part 3 consumers).
 *
 * The rollup tables have no client policies — reads go through here with the
 * service role, and every query is scoped server-side to a caller the guard
 * has already validated:
 *
 * - `/analytics/*` "me" reads scope to the ACTIVE identity from the
 *   `X-Active-Profile-Id` header. Because the header is validated with
 *   `can_act_as` and the same endpoints serve both cases, the PERSONAL
 *   dashboard and the TEAM dashboard are one contract with a different
 *   header — exactly how the app already switches identity.
 * - `/admin/analytics/*` reads are platform-wide and sit behind AdminGuard.
 *
 * Weekly/monthly views derive from the daily rows here — the raw ledger is
 * never re-processed per dashboard request, and a range read touches a
 * bounded slice of the daily layer through its indexes.
 *
 * **Additive metrics are summed; DISTINCT metrics are not.** Impressions,
 * views and engagement add up across days, so they are folded out of the daily
 * rows. Reach and active users are counts of distinct ACCOUNTS: a viewer who
 * returns tomorrow is one account for the period but two daily rows, so
 * summing them over-reports. Those come from `analytics_reach` /
 * `analytics_active_users`, which count distinct members of the daily
 * membership layer in SQL. Same daily-layer-only guarantee, correct arithmetic.
 *
 * **Ranking, pagination and platform-wide aggregation happen in SQL** —
 * `analytics_entity_top`, `analytics_identity_top`, `analytics_platform_totals`.
 * PostgREST cannot GROUP BY, so the alternative would be shipping the whole
 * platform's daily rows into Node and ranking in JavaScript, which both breaks
 * at scale and risks silent truncation against the API's max-rows ceiling.
 */

type Row = Record<string, unknown>;

/** Scope of a reach question: one post/short, or everything an identity authored. */
type ReachScope = 'entity' | 'identity';

/** Numeric field on a rollup row; missing/malformed reads as 0. */
function num(row: Row, key: string): number {
  const v = row[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  // bigint sums arrive from PostgREST as strings once they exceed 2^31.
  if (typeof v === 'string' && v !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/**
 * The additive content columns shared by every entity-rollup read. `reach` is
 * deliberately absent — see the class comment.
 */
const CONTENT_FIELDS: Partial<Record<keyof MetricTotals, string>> = {
  impressions: 'impressions',
  views: 'views',
  opens: 'opens',
  reactions: 'reactions',
  comments: 'comments',
  shares: 'shares',
  saves: 'saves',
};

const ENGAGEMENT_FIELDS: Partial<Record<keyof MetricTotals, string>> = {
  reactions: 'reactions',
  comments: 'comments',
  shares: 'shares',
  saves: 'saves',
};

/** Sums one rollup row's fields into a totals accumulator. */
function sumInto(acc: MetricTotals, row: Row, map: Partial<Record<keyof MetricTotals, string>>): MetricTotals {
  return addTotals(acc, {
    impressions: num(row, map.impressions ?? ''),
    views: num(row, map.views ?? ''),
    opens: num(row, map.opens ?? ''),
    reactions: num(row, map.reactions ?? ''),
    comments: num(row, map.comments ?? ''),
    shares: num(row, map.shares ?? ''),
    saves: num(row, map.saves ?? ''),
    reach: num(row, map.reach ?? ''),
  });
}

/** A `{bucket, value}` series built from one numeric field of dated rows. */
function fieldSeries(rows: Row[], granularity: Granularity, field: string) {
  return bucketSeries(rows as Array<Row & { stat_date: string }>, granularity, (row) => ({
    saves: num(row as Row, field),
  })).map(({ bucket, totals }) => ({ bucket, value: totals.saves }));
}

/** An engagement-per-bucket series (reactions+comments+shares+saves). */
function engagementSeries(rows: Row[], granularity: Granularity, map: Partial<Record<keyof MetricTotals, string>>) {
  return bucketSeries(rows as Array<Row & { stat_date: string }>, granularity, (row) => ({
    reactions: num(row as Row, map.reactions ?? ''),
    comments: num(row as Row, map.comments ?? ''),
    shares: num(row as Row, map.shares ?? ''),
    saves: num(row as Row, map.saves ?? ''),
  })).map(({ bucket, totals }) => ({ bucket, value: engagementOf(totals) }));
}

/** A watch funnel, with the derived rates the UI should not compute. */
function watchOf(
  starts: number,
  at25: number,
  at50: number,
  at75: number,
  completes: number,
  watchTimeMs: number,
) {
  return {
    starts,
    at25,
    at50,
    at75,
    completes,
    watch_time_ms: watchTimeMs,
    completion_rate: completionRate(starts, completes),
    // Per STARTED watch, not per view: a short that was never opened did not
    // contribute a zero-length watch, it contributed nothing.
    avg_watch_time_ms: ratioOf(watchTimeMs, starts),
  };
}

/** Per-bucket series from an `analytics_platform_totals` result set. */
function platformSeries(rows: Row[], field: string) {
  return rows
    .map((r) => ({ bucket: String(r.bucket ?? ''), value: num(r, field) }))
    .sort((a, b) => (a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : 0));
}

/** The metric bundle for one window of an identity's analytics. */
interface IdentityWindow {
  totals: MetricTotals & { engagement: number; engagement_rate: number | null };
  followers: { gained: number; lost: number; net: number };
  profile_views: number;
  watch: ReturnType<typeof watchOf>;
  sessions: number;
  events: number;
  recruitment: {
    applications_submitted: number;
    hire_requests_made: number;
    impressions: number;
    views: number;
  };
}

/** The metric bundle for one window of platform-wide analytics. */
interface PlatformWindow {
  totals: MetricTotals & { engagement: number; engagement_rate: number | null };
  active_users: number;
  /** Active accounts that were also seen before this window started. */
  returning_users: number;
  /** Active accounts whose first-ever activity falls inside this window. */
  first_seen_users: number;
  sessions: number;
  events: number;
  profile_views: number;
  followers: { gained: number; lost: number; net: number };
  /** Actor side of the social graph: follows/unfollows performed. */
  follow_actions: { follows: number; unfollows: number; net: number };
  watch: ReturnType<typeof watchOf>;
  /** Distinct identities with a rollup row, and distinct content with traffic. */
  active_identities: number;
  content_items: number;
  recruitment: {
    impressions: number;
    views: number;
    applications_submitted: number;
    hire_requests_made: number;
  };
  /** Signups and publications inside the window (transactional, not events). */
  growth: { new_users: number; new_teams: number; new_posts: number; new_shorts: number };
}

/** All-time platform composition. Not range-scoped — never mix with activity. */
interface PlatformSize {
  total_users: number;
  total_teams: number;
  total_posts: number;
  total_shorts: number;
  total_videos: number;
  total_images: number;
}

@Injectable()
export class AnalyticsReadService {
  constructor(private readonly supabase: SupabaseService) {}

  // ------------------------------------------------------------ me: overview
  /**
   * The identity dashboard contract (personal AND team): totals, engagement,
   * follower movement, the watch funnel and per-bucket series in one call.
   * Content metrics come from the entity rollup scoped to the identity's
   * ownership; audience/actor/session metrics come from the identity rollup.
   *
   * With `compare=true` the equal-length preceding window is resolved too and
   * returned as `previous` plus a `changes` block, so a card can show a delta
   * without the client running a second request or inventing the arithmetic.
   */
  async overview(identityId: string, query: AnalyticsOverviewQueryDto): Promise<unknown> {
    const { fromIso, toIso } = this.range(query);
    const granularity = query.granularity ?? 'day';

    const identityRows = await this.identityRows(identityId, fromIso, toIso);
    const entityRows = await this.ownedEntityRows(identityId, fromIso, toIso);
    const current = await this.identityWindow(identityId, fromIso, toIso, identityRows, entityRows);
    const reachSeries = await this.reachSeries('identity', identityId, fromIso, toIso, granularity);

    const base = {
      scope: { identity_id: identityId, from: fromIso, to: toIso, granularity },
      ...current,
      series: {
        impressions: fieldSeries(entityRows, granularity, 'impressions'),
        views: fieldSeries(entityRows, granularity, 'views'),
        reach: reachSeries,
        engagement: engagementSeries(entityRows, granularity, ENGAGEMENT_FIELDS),
        followers_gained: fieldSeries(identityRows, granularity, 'followers_gained'),
        followers_lost: fieldSeries(identityRows, granularity, 'followers_lost'),
        profile_views: fieldSeries(identityRows, granularity, 'profile_views'),
        watch_time_ms: fieldSeries(identityRows, granularity, 'watch_time_ms'),
        sessions: fieldSeries(identityRows, granularity, 'sessions'),
      },
    };

    if (!query.compare) return base;

    const prev = previousRange(fromIso, toIso);
    const prevIdentityRows = await this.identityRows(identityId, prev.from, prev.to);
    const prevEntityRows = await this.ownedEntityRows(identityId, prev.from, prev.to);
    const previous = await this.identityWindow(
      identityId,
      prev.from,
      prev.to,
      prevIdentityRows,
      prevEntityRows,
    );

    return {
      ...base,
      previous: { scope: { from: prev.from, to: prev.to }, ...previous },
      changes: this.identityChanges(current, previous),
    };
  }

  /** The nine deltas the dashboard cards render. */
  private identityChanges(
    current: IdentityWindow,
    previous: IdentityWindow,
  ): Record<string, MetricChange> {
    return {
      reach: changeOf(current.totals.reach, previous.totals.reach),
      impressions: changeOf(current.totals.impressions, previous.totals.impressions),
      views: changeOf(current.totals.views, previous.totals.views),
      engagement: changeOf(current.totals.engagement, previous.totals.engagement),
      profile_views: changeOf(current.profile_views, previous.profile_views),
      followers_net: changeOf(current.followers.net, previous.followers.net),
      sessions: changeOf(current.sessions, previous.sessions),
      events: changeOf(current.events, previous.events),
      watch_time_ms: changeOf(current.watch.watch_time_ms, previous.watch.watch_time_ms),
    };
  }

  /**
   * Folds one window's rollup rows into the dashboard bundle. Takes the rows as
   * arguments so `overview` can reuse them for the series without re-querying.
   */
  private async identityWindow(
    identityId: string,
    fromIso: string,
    toIso: string,
    identityRows: Row[],
    entityRows: Row[],
  ): Promise<IdentityWindow> {
    const sum = (rows: Row[], key: string) => rows.reduce((s, r) => s + num(r, key), 0);

    const totals = entityRows.reduce((acc, r) => sumInto(acc, r, CONTENT_FIELDS), emptyTotals());
    // Exact distinct accounts reached over the whole period — never a sum.
    totals.reach = await this.reachTotal('identity', identityId, fromIso, toIso);

    const gained = sum(identityRows, 'followers_gained');
    const lost = sum(identityRows, 'followers_lost');

    return {
      totals: {
        ...totals,
        engagement: engagementOf(totals),
        engagement_rate: engagementRate(totals),
      },
      followers: { gained, lost, net: gained - lost },
      profile_views: sum(identityRows, 'profile_views'),
      watch: watchOf(
        sum(identityRows, 'watch_starts'),
        sum(identityRows, 'watch_25'),
        sum(identityRows, 'watch_50'),
        sum(identityRows, 'watch_75'),
        sum(identityRows, 'watch_completes'),
        sum(identityRows, 'watch_time_ms'),
      ),
      sessions: sum(identityRows, 'sessions'),
      events: sum(identityRows, 'events'),
      recruitment: {
        applications_submitted: sum(identityRows, 'applications_submitted'),
        hire_requests_made: sum(identityRows, 'hire_requests_made'),
        // Audience side of recruitment: traffic on the identity's own
        // recruitment content, so a recruiting team can see whether its posts
        // are being seen at all.
        impressions: sum(entityRows, 'recruitment_impressions'),
        views: sum(entityRows, 'recruitment_views'),
      },
    };
  }

  // --------------------------------------------------------- me: top content
  /**
   * Top posts or shorts for the identity, ranked on the requested dimension and
   * paginated. Ranking happens in SQL against the exact distinct reach, so
   * ordering by reach cannot put the wrong content at the top.
   */
  async topContent(identityId: string, query: AnalyticsTopContentQueryDto): Promise<unknown> {
    return this.entityLeaderboard(identityId, query);
  }

  // ----------------------------------------------------------- me: content
  /** One entity's performance over the range (content-performance detail). */
  async contentDetail(
    identityId: string,
    entityId: string,
    query: AnalyticsQueryDto,
  ): Promise<unknown> {
    return this.contentDetailFor(entityId, query, identityId);
  }

  // ----------------------------------------------------------- admin: reads
  /**
   * Platform-wide overview for analytics-admin — the control-center payload.
   *
   * Three families of number live here and are deliberately kept apart, because
   * conflating them is the classic way an analytics console starts lying:
   *
   * - `platform`  all-time composition (accounts, posts, shorts, videos). Not
   *               range-scoped, so it has no comparison and never appears in
   *               `changes`.
   * - `totals`    everything measured INSIDE the selected range.
   * - `derived`   averages and ratios computed from those totals, server-side,
   *               so the browser never divides two metrics and invents a third.
   *
   * `active_users`, `returning_users`, `active_identities`, `content_items` and
   * `reach` are exact DISTINCT counts from SQL; nothing here is a sum of daily
   * distinct values.
   */
  async adminOverview(query: AnalyticsOverviewQueryDto): Promise<unknown> {
    const { fromIso, toIso } = this.range(query);
    const granularity = query.granularity ?? 'day';

    const [current, seriesRows, growthRows, activeUsersSeries, reachSeries, size] =
      await Promise.all([
        this.platformWindow(fromIso, toIso),
        this.platformTotals(fromIso, toIso, granularity),
        this.platformGrowth(fromIso, toIso, granularity),
        this.activeUsersSeries(fromIso, toIso, granularity),
        this.reachSeries('identity', null, fromIso, toIso, granularity),
        this.platformSize(),
      ]);

    const base = {
      scope: { from: fromIso, to: toIso, granularity },
      platform: size,
      totals: this.platformTotalsPayload(current),
      derived: this.platformDerived(current),
      followers: current.followers,
      follow_actions: current.follow_actions,
      watch: current.watch,
      recruitment: current.recruitment,
      series: {
        // Audience
        active_users: activeUsersSeries,
        active_identities: platformSeries(seriesRows, 'active_identities'),
        sessions: platformSeries(seriesRows, 'sessions'),
        events: platformSeries(seriesRows, 'events'),
        new_users: platformSeries(growthRows, 'new_users'),
        new_teams: platformSeries(growthRows, 'new_teams'),
        // Content published
        new_posts: platformSeries(growthRows, 'new_posts'),
        new_shorts: platformSeries(growthRows, 'new_shorts'),
        content_items: platformSeries(seriesRows, 'content_items'),
        // Consumption
        impressions: platformSeries(seriesRows, 'impressions'),
        views: platformSeries(seriesRows, 'views'),
        opens: platformSeries(seriesRows, 'opens'),
        reach: reachSeries,
        profile_views: platformSeries(seriesRows, 'profile_views'),
        watch_time_ms: platformSeries(seriesRows, 'watch_time_ms'),
        // Engagement
        engagement: platformSeries(seriesRows, 'engagement'),
        reactions: platformSeries(seriesRows, 'reactions'),
        comments: platformSeries(seriesRows, 'comments'),
        shares: platformSeries(seriesRows, 'shares'),
        saves: platformSeries(seriesRows, 'saves'),
        // Social graph
        followers_gained: platformSeries(seriesRows, 'followers_gained'),
        followers_lost: platformSeries(seriesRows, 'followers_lost'),
        follows_made: platformSeries(seriesRows, 'follows_made'),
        unfollows_made: platformSeries(seriesRows, 'unfollows_made'),
        // Recruitment
        recruitment_impressions: platformSeries(seriesRows, 'recruitment_impressions'),
        recruitment_views: platformSeries(seriesRows, 'recruitment_views'),
        applications_submitted: platformSeries(seriesRows, 'applications_submitted'),
        hire_requests_made: platformSeries(seriesRows, 'hire_requests_made'),
      },
    };

    if (!query.compare) return base;

    const prev = previousRange(fromIso, toIso);
    const previous = await this.platformWindow(prev.from, prev.to);

    return {
      ...base,
      previous: {
        scope: { from: prev.from, to: prev.to },
        totals: this.platformTotalsPayload(previous),
        derived: this.platformDerived(previous),
        followers: previous.followers,
        follow_actions: previous.follow_actions,
        watch: previous.watch,
        recruitment: previous.recruitment,
      },
      changes: this.platformChanges(current, previous),
    };
  }

  /**
   * The range-scoped totals, flat and identically shaped for the current and
   * previous window so a card can read `totals[k]` / `previous.totals[k]`
   * without either side special-casing a key.
   */
  private platformTotalsPayload(w: PlatformWindow): Record<string, number | null> {
    return {
      // Audience
      active_users: w.active_users,
      returning_users: w.returning_users,
      first_seen_users: w.first_seen_users,
      active_identities: w.active_identities,
      sessions: w.sessions,
      events: w.events,
      new_users: w.growth.new_users,
      new_teams: w.growth.new_teams,
      // Content
      posts_published: w.growth.new_posts,
      shorts_published: w.growth.new_shorts,
      content_items: w.content_items,
      // Consumption
      impressions: w.totals.impressions,
      views: w.totals.views,
      opens: w.totals.opens,
      reach: w.totals.reach,
      profile_views: w.profile_views,
      watch_time_ms: w.watch.watch_time_ms,
      // Engagement
      engagement: w.totals.engagement,
      engagement_rate: w.totals.engagement_rate,
      reactions: w.totals.reactions,
      comments: w.totals.comments,
      shares: w.totals.shares,
      saves: w.totals.saves,
      // Social graph
      followers_gained: w.followers.gained,
      followers_lost: w.followers.lost,
      followers_net: w.followers.net,
      follows_made: w.follow_actions.follows,
      unfollows_made: w.follow_actions.unfollows,
      // Recruitment
      recruitment_impressions: w.recruitment.impressions,
      recruitment_views: w.recruitment.views,
      applications_submitted: w.recruitment.applications_submitted,
      hire_requests_made: w.recruitment.hire_requests_made,
    };
  }

  /**
   * Averages and ratios, decided here rather than in the browser.
   *
   * Each one is null when its denominator is zero. The three reach ratios are
   * the only comparison between reach, impressions and views this API offers,
   * and they are ratios precisely BECAUSE the three are different questions —
   * impressions ÷ reach is "times seen per account reached", not a conversion.
   */
  private platformDerived(w: PlatformWindow): Record<string, number | null> {
    return {
      avg_views_per_content: ratioOf(w.totals.views, w.content_items),
      avg_engagement_per_content: ratioOf(w.totals.engagement, w.content_items),
      avg_events_per_session: ratioOf(w.events, w.sessions),
      avg_sessions_per_user: ratioOf(w.sessions, w.active_users),
      avg_watch_time_ms: w.watch.avg_watch_time_ms,
      returning_user_rate: ratioOf(w.returning_users, w.active_users),
      views_per_reach: ratioOf(w.totals.views, w.totals.reach),
      impressions_per_reach: ratioOf(w.totals.impressions, w.totals.reach),
      engagement_per_reach: w.totals.engagement_rate,
      completion_rate: w.watch.completion_rate,
    };
  }

  /** Period-over-period deltas for every additive total the cards render. */
  private platformChanges(
    current: PlatformWindow,
    previous: PlatformWindow,
  ): Record<string, MetricChange> {
    const now = this.platformTotalsPayload(current);
    const before = this.platformTotalsPayload(previous);
    const changes: Record<string, MetricChange> = {};
    for (const key of Object.keys(now)) {
      const a = now[key];
      const b = before[key];
      // `engagement_rate` is a rate, and a rate's percentage change is a
      // percentage of a percentage — meaningless on a card. Rates are compared
      // by showing both values, not by a delta.
      if (key === 'engagement_rate' || a === null || b === null) continue;
      changes[key] = changeOf(a, b);
    }
    return changes;
  }

  /** Top identities in the range, ranked in SQL, with display fields and type. */
  async adminTopIdentities(query: AnalyticsTopIdentitiesQueryDto): Promise<unknown> {
    const { fromIso, toIso } = this.range(query);
    const limit = query.limit ?? 10;
    const offset = query.offset ?? 0;

    const rows = await this.supabase.rpcAsService<Row[]>('analytics_identity_top', {
      p_from: fromIso,
      p_to: toIso,
      p_kind: query.identityType ?? null,
      p_order: query.order ?? 'reach',
      p_limit: limit,
      p_offset: offset,
    });
    const ordered = Array.isArray(rows) ? rows : [];
    const scope = {
      from: fromIso,
      to: toIso,
      order: query.order ?? 'reach',
      identity_type: query.identityType ?? 'all',
      limit,
      offset,
    };
    if (ordered.length === 0) return { scope, items: [], identities: {}, total: 0 };

    const identities = await this.fetchIdentities(ordered.map((r) => String(r.identity_id)));

    return {
      scope,
      total: num(ordered[0], 'total_count'),
      items: ordered.map((r) => {
        // SQL already summed the four engagement components into one figure, so
        // the rate is computed from it directly against the same reach
        // denominator `engagementRate` uses — engagement ÷ unique reach, null at
        // zero reach.
        const engagement = num(r, 'engagement');
        const reach = num(r, 'reach_users');
        const contentCount = num(r, 'content_count');
        const watchStarts = num(r, 'watch_starts');
        const watchTime = num(r, 'watch_time_ms');
        return {
          identity_id: String(r.identity_id),
          // `kind` comes from `identities`, so personal and team stay
          // distinguishable without the client guessing from the id.
          kind: String(r.kind ?? ''),
          reach,
          impressions: num(r, 'impressions'),
          views: num(r, 'views'),
          opens: num(r, 'opens'),
          engagement,
          engagement_rate: ratioOf(engagement, reach),
          reactions: num(r, 'reactions'),
          comments: num(r, 'comments'),
          shares: num(r, 'shares'),
          saves: num(r, 'saves'),
          profile_views: num(r, 'profile_views'),
          followers: {
            gained: num(r, 'followers_gained'),
            lost: num(r, 'followers_lost'),
            net: num(r, 'followers_gained') - num(r, 'followers_lost'),
          },
          watch_time_ms: watchTime,
          watch_starts: watchStarts,
          watch_completes: num(r, 'watch_completes'),
          completion_rate: completionRate(watchStarts, num(r, 'watch_completes')),
          sessions: num(r, 'sessions'),
          events: num(r, 'events'),
          // Distinct pieces of this identity's content that saw traffic in the
          // range — the "content output" ranking dimension.
          content_count: contentCount,
          avg_views_per_content: ratioOf(num(r, 'views'), contentCount),
          identity: identities.get(String(r.identity_id)) ?? null,
        };
      }),
      identities: Object.fromEntries(identities.entries()),
    };
  }

  /**
   * One identity's full analytics, platform scope — the admin drill-down behind
   * a leaderboard row.
   *
   * Reuses `identityWindow`, the SAME function the Flutter identity dashboard
   * calls, so an operator investigating a creator sees exactly the numbers that
   * creator sees. The only differences are scope (no `X-Active-Profile-Id`, the
   * id comes from the route) and the extras an operator needs: the identity's own
   * top content, its reaction mix, and the display row.
   *
   * A 404 for an unknown identity is answered before any rollup is read, so the
   * route cannot be used to enumerate ids by timing.
   */
  async adminIdentityDetail(
    identityId: string,
    query: AnalyticsOverviewQueryDto,
  ): Promise<unknown> {
    if (!isUuid(identityId)) throw AppException.badRequest('identityId must be a uuid.');
    const { fromIso, toIso } = this.range(query);
    const granularity = query.granularity ?? 'day';

    const identities = await this.fetchIdentities([identityId]);
    const identity = identities.get(identityId) ?? null;
    if (!identity) throw AppException.notFound('No such identity.');

    const [identityRows, entityRows, reachSeries, reactionMix, topPosts, topShorts] =
      await Promise.all([
        this.identityRows(identityId, fromIso, toIso),
        this.ownedEntityRows(identityId, fromIso, toIso),
        this.reachSeries('identity', identityId, fromIso, toIso, granularity),
        this.reactionMix(fromIso, toIso, null, identityId),
        this.entityLeaderboard(identityId, {
          from: fromIso,
          to: toIso,
          kind: 'post',
          order: 'views',
          limit: 5,
        } as AnalyticsTopContentQueryDto),
        this.entityLeaderboard(identityId, {
          from: fromIso,
          to: toIso,
          kind: 'short',
          order: 'views',
          limit: 5,
        } as AnalyticsTopContentQueryDto),
      ]);

    const current = await this.identityWindow(
      identityId,
      fromIso,
      toIso,
      identityRows,
      entityRows,
    );

    const contentItems = new Set(entityRows.map((r) => String(r.entity_id))).size;
    const base = {
      scope: { identity_id: identityId, from: fromIso, to: toIso, granularity },
      identity,
      kind: String(identity.kind ?? ''),
      ...current,
      derived: {
        content_items: contentItems,
        avg_views_per_content: ratioOf(current.totals.views, contentItems),
        views_per_reach: ratioOf(current.totals.views, current.totals.reach),
        impressions_per_reach: ratioOf(current.totals.impressions, current.totals.reach),
        engagement_per_reach: current.totals.engagement_rate,
        avg_watch_time_ms: current.watch.avg_watch_time_ms,
        completion_rate: current.watch.completion_rate,
      },
      reaction_mix: reactionMix,
      top_posts: topPosts,
      top_shorts: topShorts,
      series: {
        impressions: fieldSeries(entityRows, granularity, 'impressions'),
        views: fieldSeries(entityRows, granularity, 'views'),
        reach: reachSeries,
        engagement: engagementSeries(entityRows, granularity, ENGAGEMENT_FIELDS),
        reactions: fieldSeries(entityRows, granularity, 'reactions'),
        comments: fieldSeries(entityRows, granularity, 'comments'),
        shares: fieldSeries(entityRows, granularity, 'shares'),
        saves: fieldSeries(entityRows, granularity, 'saves'),
        followers_gained: fieldSeries(identityRows, granularity, 'followers_gained'),
        followers_lost: fieldSeries(identityRows, granularity, 'followers_lost'),
        profile_views: fieldSeries(identityRows, granularity, 'profile_views'),
        watch_time_ms: fieldSeries(identityRows, granularity, 'watch_time_ms'),
        sessions: fieldSeries(identityRows, granularity, 'sessions'),
      },
    };

    if (!query.compare) return base;

    const prev = previousRange(fromIso, toIso);
    const [prevIdentityRows, prevEntityRows] = await Promise.all([
      this.identityRows(identityId, prev.from, prev.to),
      this.ownedEntityRows(identityId, prev.from, prev.to),
    ]);
    const previous = await this.identityWindow(
      identityId,
      prev.from,
      prev.to,
      prevIdentityRows,
      prevEntityRows,
    );

    return {
      ...base,
      previous: { scope: { from: prev.from, to: prev.to }, ...previous },
      changes: this.identityChanges(current, previous),
    };
  }

  /**
   * The reaction-type mix (love / fire / laughing / angry), platform-wide or
   * scoped to one content item or one author.
   *
   * Read from the `reactions` table and the `reaction_types` taxonomy, NOT from
   * the rollups: `analytics_daily_entity.reactions` is a single untyped count,
   * and the ledger's reaction events carry no type either. The consequence is a
   * different question — reactions CREATED in the range that still STAND, versus
   * the rollup's reaction EVENTS — and callers must present it as such rather
   * than as a decomposition of the engagement total.
   */
  async adminReactionMix(query: AnalyticsReactionMixQueryDto): Promise<unknown> {
    const { fromIso, toIso } = this.range(query);
    if (query.entityId !== undefined && !isUuid(query.entityId)) {
      throw AppException.badRequest('entityId must be a uuid.');
    }
    if (query.identityId !== undefined && !isUuid(query.identityId)) {
      throw AppException.badRequest('identityId must be a uuid.');
    }
    return {
      scope: {
        from: fromIso,
        to: toIso,
        entity_id: query.entityId ?? null,
        identity_id: query.identityId ?? null,
        // Named in the payload so a client cannot mistake this for the rollup's
        // reaction count.
        source: 'reactions_standing',
      },
      items: await this.reactionMix(fromIso, toIso, query.entityId ?? null, query.identityId ?? null),
    };
  }

  /** How published content splits by format, author type, media and post type. */
  async adminContentDistribution(query: AnalyticsQueryDto): Promise<unknown> {
    const { fromIso, toIso } = this.range(query);
    const rows = await this.supabase.rpcAsService<Row[]>('analytics_content_distribution', {
      p_from: fromIso,
      p_to: toIso,
    });
    const list = Array.isArray(rows) ? rows : [];

    // Group into { dimension: [{key,label,items}] } so a client renders one
    // breakdown per dimension without filtering the flat list itself.
    const groups: Record<string, Array<{ key: string; label: string; items: number }>> = {};
    for (const row of list) {
      const dimension = String(row.dimension ?? '');
      (groups[dimension] ??= []).push({
        key: String(row.key ?? ''),
        label: String(row.label ?? ''),
        items: num(row, 'items'),
      });
    }

    return {
      scope: { from: fromIso, to: toIso, basis: 'published_at' },
      dimensions: groups,
    };
  }

  /**
   * When the analytics layer was last processed.
   *
   * The console shows this verbatim. Every number it displays comes from daily
   * rollups written by the nightly aggregation, so presenting them as real time
   * would be a lie; `stale` says whether the newest aggregated day is behind
   * yesterday, which is the operator's signal that the scheduler has stopped.
   */
  async adminFreshness(): Promise<unknown> {
    const rows = await this.supabase.rpcAsService<Row[]>('analytics_freshness', {});
    const list = Array.isArray(rows) ? rows : [];

    const layers = list.map((row) => ({
      layer: String(row.layer ?? ''),
      last_stat_date: row.last_stat_date ? String(row.last_stat_date) : null,
      last_computed_at: row.last_computed_at ? String(row.last_computed_at) : null,
      rows_total: num(row, 'rows_total'),
    }));

    const lastComputedAt = layers
      .map((l) => l.last_computed_at)
      .filter((v): v is string => v !== null)
      .sort()
      .at(-1) ?? null;
    const lastStatDate = layers
      .filter((l) => l.layer !== 'events')
      .map((l) => l.last_stat_date)
      .filter((v): v is string => v !== null)
      .sort()
      .at(-1) ?? null;

    // Yesterday UTC: today's bucket is not expected to exist yet, because the
    // aggregation runs after midnight for the day that just closed.
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

    return {
      // Stated explicitly so no consumer has to infer it.
      mode: 'daily_aggregate',
      last_processed_at: lastComputedAt,
      last_complete_day: lastStatDate,
      expected_complete_day: yesterday,
      stale: lastStatDate === null || lastStatDate < yesterday,
      layers,
    };
  }

  /** Shared reaction-mix read, used by the mix route and both detail views. */
  private async reactionMix(
    fromIso: string,
    toIso: string,
    entityId: string | null,
    identityId: string | null,
  ): Promise<Array<{ type_id: string; label: string; emoji: string | null; reactions: number }>> {
    const rows = await this.supabase.rpcAsService<Row[]>('analytics_reaction_mix', {
      p_from: fromIso,
      p_to: toIso,
      p_entity: entityId,
      p_owner: identityId,
    });
    return (Array.isArray(rows) ? rows : []).map((row) => ({
      type_id: String(row.type_id ?? ''),
      label: String(row.label ?? ''),
      emoji: row.emoji ? String(row.emoji) : null,
      reactions: num(row, 'reactions'),
    }));
  }

  /** Top content platform-wide, ranked in SQL, with owner identity attached. */
  async adminTopContent(query: AnalyticsTopContentQueryDto): Promise<unknown> {
    return this.entityLeaderboard(null, query);
  }

  /**
   * One content item's performance, platform scope (no owner restriction), plus
   * the reaction-type mix an operator needs to see WHICH reaction a post earned.
   * The mix comes from the reactions table, not the rollup — see
   * {@link adminReactionMix} for why, and note the different question it answers.
   */
  async adminContentDetail(entityId: string, query: AnalyticsQueryDto): Promise<unknown> {
    const detail = await this.contentDetailFor(entityId, query, null);
    const { fromIso, toIso } = this.range(query);
    return {
      ...(detail as Record<string, unknown>),
      reaction_mix: await this.reactionMix(fromIso, toIso, entityId, null),
    };
  }

  // ------------------------------------------------------- shared: content
  /**
   * The top-content leaderboard, shared by the identity dashboard and the admin
   * console. `ownerIdentityId` null means platform-wide; non-null scopes to that
   * identity's own content. One code path so a post's numbers are identical
   * whichever surface asks.
   */
  private async entityLeaderboard(
    ownerIdentityId: string | null,
    query: AnalyticsTopContentQueryDto,
  ): Promise<unknown> {
    const { fromIso, toIso } = this.range(query);
    const limit = query.limit ?? 10;
    const offset = query.offset ?? 0;
    const order = query.order ?? 'views';

    const rows = await this.supabase.rpcAsService<Row[]>('analytics_entity_top', {
      p_from: fromIso,
      p_to: toIso,
      p_owner: ownerIdentityId,
      p_kind: query.kind ?? null,
      p_order: order,
      p_limit: limit,
      p_offset: offset,
    });
    const ordered = Array.isArray(rows) ? rows : [];

    const scope = {
      ...(ownerIdentityId ? { identity_id: ownerIdentityId } : {}),
      from: fromIso,
      to: toIso,
      kind: query.kind ?? 'all',
      order,
      limit,
      offset,
    };
    if (ordered.length === 0) return { scope, items: [], posts: {}, identities: {}, total: 0 };

    const entityIds = ordered.map((r) => String(r.entity_id));
    const ownerIds = [
      ...new Set(
        ordered
          .map((r) => (r.owner_identity_id ? String(r.owner_identity_id) : null))
          .filter((v): v is string => v !== null),
      ),
    ];
    const [posts, identities] = await Promise.all([
      this.fetchPosts(entityIds),
      // Only the admin surface needs owner display rows; the identity dashboard
      // already knows whose content it is.
      ownerIdentityId === null ? this.fetchIdentities(ownerIds) : Promise.resolve(new Map<string, Row>()),
    ]);

    return {
      scope,
      total: num(ordered[0], 'total_count'),
      items: ordered.map((r) => {
        const totals: MetricTotals = {
          impressions: num(r, 'impressions'),
          views: num(r, 'views'),
          opens: num(r, 'opens'),
          reactions: num(r, 'reactions'),
          comments: num(r, 'comments'),
          shares: num(r, 'shares'),
          saves: num(r, 'saves'),
          reach: num(r, 'reach_users'),
        };
        const entityId = String(r.entity_id);
        const owner = r.owner_identity_id ? String(r.owner_identity_id) : null;
        return {
          entity_id: entityId,
          is_short: r.is_short === true,
          owner_identity_id: owner,
          totals: {
            ...totals,
            engagement: engagementOf(totals),
            engagement_rate: engagementRate(totals),
          },
          watch: watchOf(
            num(r, 'watch_starts'),
            num(r, 'watch_25'),
            num(r, 'watch_50'),
            num(r, 'watch_75'),
            num(r, 'watch_completes'),
            num(r, 'watch_time_ms'),
          ),
          recruitment: {
            impressions: num(r, 'recruitment_impressions'),
            views: num(r, 'recruitment_views'),
          },
          post: posts.get(entityId) ?? null,
          identity: owner ? identities.get(owner) ?? null : null,
        };
      }),
      posts: Object.fromEntries(posts.entries()),
      identities: Object.fromEntries(identities.entries()),
    };
  }

  /**
   * One entity's performance. When `ownerIdentityId` is given the read is
   * owner-scoped and answers 404 for anything else; when null it is the admin
   * view and any content with rollup rows is readable.
   */
  private async contentDetailFor(
    entityId: string,
    query: AnalyticsQueryDto,
    ownerIdentityId: string | null,
  ): Promise<unknown> {
    if (!isUuid(entityId)) throw AppException.badRequest('entityId must be a uuid.');
    const { fromIso, toIso } = this.range(query);
    const granularity = query.granularity ?? 'day';

    const rows = await this.run<Row[]>(
      this.supabase
        .service()
        .from('analytics_daily_entity')
        .select('*')
        .eq('entity_id', entityId)
        .gte('stat_date', fromIso)
        .lte('stat_date', toIso)
        .order('stat_date'),
    );

    // One answer for "no data", "not yours" and "owner no longer resolvable"
    // (a hard-deleted post leaves owner_identity_id null). Distinguishing them
    // would let a caller probe which posts exist and which ones get traffic.
    const notMine =
      ownerIdentityId !== null &&
      (rows.length === 0 || rows.some((r) => r.owner_identity_id !== ownerIdentityId));
    if (notMine || rows.length === 0) {
      throw AppException.notFound('No analytics for this content in the range.');
    }

    const totals = rows.reduce((acc, r) => sumInto(acc, r, CONTENT_FIELDS), emptyTotals());
    totals.reach = await this.reachTotal('entity', entityId, fromIso, toIso);
    const sum = (key: string) => rows.reduce((s, r) => s + num(r, key), 0);
    const isShort = rows.some((r) => r.is_short === true);
    const owner = rows.map((r) => r.owner_identity_id).find((v) => v != null);
    const [posts, identities] = await Promise.all([
      this.fetchPosts([entityId]),
      ownerIdentityId === null && owner
        ? this.fetchIdentities([String(owner)])
        : Promise.resolve(new Map<string, Row>()),
    ]);

    return {
      scope: { entity_id: entityId, from: fromIso, to: toIso, granularity },
      is_short: isShort,
      owner_identity_id: owner ? String(owner) : null,
      totals: { ...totals, engagement: engagementOf(totals), engagement_rate: engagementRate(totals) },
      watch: watchOf(
        sum('watch_starts'),
        sum('watch_25'),
        sum('watch_50'),
        sum('watch_75'),
        sum('watch_completes'),
        sum('watch_time_ms'),
      ),
      // Ratios decided here so the detail view never divides two metrics itself.
      derived: {
        views_per_reach: ratioOf(totals.views, totals.reach),
        impressions_per_reach: ratioOf(totals.impressions, totals.reach),
        engagement_per_reach: engagementRate(totals),
        avg_watch_time_ms: ratioOf(sum('watch_time_ms'), sum('watch_starts')),
        completion_rate: completionRate(sum('watch_starts'), sum('watch_completes')),
      },
      recruitment: {
        impressions: sum('recruitment_impressions'),
        views: sum('recruitment_views'),
      },
      series: {
        views: fieldSeries(rows, granularity, 'views'),
        impressions: fieldSeries(rows, granularity, 'impressions'),
        opens: fieldSeries(rows, granularity, 'opens'),
        reach: await this.reachSeries('entity', entityId, fromIso, toIso, granularity),
        engagement: engagementSeries(rows, granularity, ENGAGEMENT_FIELDS),
        reactions: fieldSeries(rows, granularity, 'reactions'),
        comments: fieldSeries(rows, granularity, 'comments'),
        shares: fieldSeries(rows, granularity, 'shares'),
        saves: fieldSeries(rows, granularity, 'saves'),
        watch_time_ms: fieldSeries(rows, granularity, 'watch_time_ms'),
      },
      post: posts.get(entityId) ?? null,
      identity: owner ? identities.get(String(owner)) ?? null : null,
    };
  }

  // ------------------------------------------------------- platform windows
  /** Folds one window of platform-wide analytics into a comparable bundle. */
  private async platformWindow(fromIso: string, toIso: string): Promise<PlatformWindow> {
    const [rows, audience, reach, growthRows] = await Promise.all([
      this.platformTotals(fromIso, toIso, 'total'),
      this.audience(fromIso, toIso),
      this.reachTotal('identity', null, fromIso, toIso),
      this.platformGrowth(fromIso, toIso, 'total'),
    ]);
    const row = rows[0] ?? {};
    const growthRow = growthRows[0] ?? {};
    const totals: MetricTotals = {
      impressions: num(row, 'impressions'),
      views: num(row, 'views'),
      opens: num(row, 'opens'),
      reactions: num(row, 'reactions'),
      comments: num(row, 'comments'),
      shares: num(row, 'shares'),
      saves: num(row, 'saves'),
      reach,
    };
    const gained = num(row, 'followers_gained');
    const lost = num(row, 'followers_lost');
    const follows = num(row, 'follows_made');
    const unfollows = num(row, 'unfollows_made');

    return {
      totals: {
        ...totals,
        engagement: engagementOf(totals),
        engagement_rate: engagementRate(totals),
      },
      active_users: audience.active_users,
      returning_users: audience.returning_users,
      first_seen_users: audience.new_users,
      sessions: num(row, 'sessions'),
      events: num(row, 'events'),
      profile_views: num(row, 'profile_views'),
      followers: { gained, lost, net: gained - lost },
      follow_actions: { follows, unfollows, net: follows - unfollows },
      watch: watchOf(
        num(row, 'watch_starts'),
        num(row, 'watch_25'),
        num(row, 'watch_50'),
        num(row, 'watch_75'),
        num(row, 'watch_completes'),
        num(row, 'watch_time_ms'),
      ),
      active_identities: num(row, 'active_identities'),
      content_items: num(row, 'content_items'),
      recruitment: {
        impressions: num(row, 'recruitment_impressions'),
        views: num(row, 'recruitment_views'),
        applications_submitted: num(row, 'applications_submitted'),
        hire_requests_made: num(row, 'hire_requests_made'),
      },
      growth: {
        new_users: num(growthRow, 'new_users'),
        new_teams: num(growthRow, 'new_teams'),
        new_posts: num(growthRow, 'new_posts'),
        new_shorts: num(growthRow, 'new_shorts'),
      },
    };
  }

  private async platformTotals(
    fromIso: string,
    toIso: string,
    granularity: Granularity | 'total',
  ): Promise<Row[]> {
    const rows = await this.supabase.rpcAsService<Row[]>('analytics_platform_totals', {
      p_from: fromIso,
      p_to: toIso,
      p_granularity: granularity,
    });
    return Array.isArray(rows) ? rows : [];
  }

  /** Signups and publications per bucket (or one 'total' row). */
  private async platformGrowth(
    fromIso: string,
    toIso: string,
    granularity: Granularity | 'total',
  ): Promise<Row[]> {
    const rows = await this.supabase.rpcAsService<Row[]>('analytics_platform_growth', {
      p_from: fromIso,
      p_to: toIso,
      p_granularity: granularity,
    });
    return Array.isArray(rows) ? rows : [];
  }

  /**
   * Active / returning / first-seen accounts. All three are distinct counts done
   * in SQL — `returning` in particular is a question about history that no daily
   * row can answer, so it can never be derived client-side.
   */
  private async audience(
    fromIso: string,
    toIso: string,
  ): Promise<{ active_users: number; returning_users: number; new_users: number }> {
    const rows = await this.supabase.rpcAsService<Row[]>('analytics_audience', {
      p_from: fromIso,
      p_to: toIso,
    });
    const row = (Array.isArray(rows) ? rows[0] : undefined) ?? {};
    return {
      active_users: num(row, 'active_users'),
      returning_users: num(row, 'returning_users'),
      new_users: num(row, 'new_users'),
    };
  }

  /**
   * All-time platform composition, in one RPC. Not range-scoped: "how many
   * accounts exist" is not an event, and the overview labels it apart from
   * everything measured inside the selected range.
   */
  private async platformSize(): Promise<PlatformSize> {
    const rows = await this.supabase.rpcAsService<Row[]>('analytics_platform_size', {});
    const row = (Array.isArray(rows) ? rows[0] : undefined) ?? {};
    return {
      total_users: num(row, 'total_users'),
      total_teams: num(row, 'total_teams'),
      total_posts: num(row, 'total_posts'),
      total_shorts: num(row, 'total_shorts'),
      total_videos: num(row, 'total_videos'),
      total_images: num(row, 'total_images'),
    };
  }

  // ------------------------------------------------------------ reach reads
  /**
   * Exact distinct accounts reached in `[from, to]`. `scopeId` null means
   * "every scope_id" — the platform-wide figure for the admin surface.
   */
  private async reachTotal(
    scope: ReachScope,
    scopeId: string | null,
    fromIso: string,
    toIso: string,
  ): Promise<number> {
    const rows = await this.callReach(scope, scopeId === null ? null : [scopeId], fromIso, toIso, 'total');
    return rows.length > 0 ? Number(rows[0].reach_users) || 0 : 0;
  }

  /** Exact reach per bucket. Each bucket is counted independently — never summed. */
  private async reachSeries(
    scope: ReachScope,
    scopeId: string | null,
    fromIso: string,
    toIso: string,
    granularity: Granularity,
  ): Promise<Array<{ bucket: string; value: number }>> {
    const rows = await this.callReach(
      scope,
      scopeId === null ? null : [scopeId],
      fromIso,
      toIso,
      granularity,
    );
    return rows
      .map((r) => ({ bucket: String(r.bucket ?? ''), value: Number(r.reach_users) || 0 }))
      .sort((a, b) => (a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : 0));
  }

  private async callReach(
    scope: ReachScope,
    scopeIds: string[] | null,
    fromIso: string,
    toIso: string,
    granularity: Granularity | 'total',
  ): Promise<Array<{ bucket: string | null; scope_id: string | null; reach_users: number }>> {
    const rows = await this.supabase.rpcAsService<
      Array<{ bucket: string | null; scope_id: string | null; reach_users: number }>
    >('analytics_reach', {
      p_scope: scope,
      p_from: fromIso,
      p_to: toIso,
      p_scope_ids: scopeIds,
      p_granularity: granularity,
    });
    return Array.isArray(rows) ? rows : [];
  }

  /**
   * Exact distinct active accounts PER BUCKET.
   *
   * The period TOTAL deliberately does not come from here — it comes from
   * `analytics_audience`, which returns active/returning/first-seen together so
   * the three are guaranteed to add up. The two functions compute `active_users`
   * identically (`count(distinct user_id)` over `analytics_daily_session` in the
   * range); if they ever diverge, one of them is wrong.
   */
  private async activeUsersSeries(
    fromIso: string,
    toIso: string,
    granularity: Granularity,
  ): Promise<Array<{ bucket: string; value: number }>> {
    const rows = await this.callActiveUsers(fromIso, toIso, granularity);
    return rows
      .map((r) => ({ bucket: String(r.bucket ?? ''), value: Number(r.active_users) || 0 }))
      .sort((a, b) => (a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : 0));
  }

  private async callActiveUsers(
    fromIso: string,
    toIso: string,
    granularity: Granularity | 'total',
  ): Promise<Array<{ bucket: string | null; active_users: number }>> {
    const rows = await this.supabase.rpcAsService<Array<{ bucket: string | null; active_users: number }>>(
      'analytics_active_users',
      { p_from: fromIso, p_to: toIso, p_granularity: granularity },
    );
    return Array.isArray(rows) ? rows : [];
  }

  // ----------------------------------------------------------------- helpers
  /** Validates the query range into ISO day strings, or throws a clean 400. */
  private range(query: AnalyticsQueryDto): { fromIso: string; toIso: string } {
    const parsed = parseRange(query.from, query.to);
    if (typeof parsed === 'string') throw AppException.badRequest(parsed);
    return {
      fromIso: parsed.from.toISOString().slice(0, 10),
      toIso: parsed.to.toISOString().slice(0, 10),
    };
  }

  /** Runs a rollup query, mapping failures to the standard upstream error. */
  private async run<T>(
    builder: PromiseLike<{ data: unknown; error: { message: string } | null }>,
  ): Promise<T> {
    const { data, error } = await builder;
    if (error) throw AppException.upstream(error.message);
    return (data ?? []) as T;
  }

  private identityRows(identityId: string, fromIso: string, toIso: string): Promise<Row[]> {
    return this.run<Row[]>(
      this.supabase
        .service()
        .from('analytics_daily_identity')
        .select('*')
        .eq('identity_id', identityId)
        .gte('stat_date', fromIso)
        .lte('stat_date', toIso)
        .order('stat_date'),
    );
  }

  private ownedEntityRows(
    identityId: string,
    fromIso: string,
    toIso: string,
    kind?: 'post' | 'short',
  ): Promise<Row[]> {
    let builder = this.supabase
      .service()
      .from('analytics_daily_entity')
      .select('*')
      .eq('owner_identity_id', identityId)
      .gte('stat_date', fromIso)
      .lte('stat_date', toIso)
      .order('stat_date');
    if (kind === 'post') builder = builder.eq('is_short', false);
    if (kind === 'short') builder = builder.eq('is_short', true);
    return this.run<Row[]>(builder);
  }

  /**
   * Display fields for a list of content ids: the post row, a thumbnail, and the
   * game a recruitment post is about.
   *
   * Best-effort by design — metrics stand on their own and a failed decoration
   * must never fail a dashboard, so every step degrades to "no decoration".
   *
   * Three bounded queries rather than one join: PostgREST cannot express
   * "first non-deleted media per post", and the id list is at most one page
   * (≤ 100), so this is three indexed `in (…)` lookups, not an N+1.
   */
  private async fetchPosts(entityIds: string[]): Promise<Map<string, Row>> {
    const map = new Map<string, Row>();
    if (entityIds.length === 0) return map;
    const { data, error } = await this.supabase
      .service()
      .from('posts')
      .select('id, type_id, caption, visibility, created_at, deleted_at, author_id')
      .in('id', entityIds);
    if (error) return map; // metrics stand alone; titles are decoration
    for (const row of (data ?? []) as unknown as Row[]) map.set(String(row.id), row);

    await Promise.all([this.attachThumbnails(map), this.attachGames(map)]);
    return map;
  }

  /**
   * Attaches the lowest-slot surviving attachment of each post as its preview.
   * Prefers `thumbnail_url` (a video's poster frame) over `public_url`, so a
   * shorts leaderboard shows stills rather than trying to load videos.
   */
  private async attachThumbnails(posts: Map<string, Row>): Promise<void> {
    if (posts.size === 0) return;
    const { data, error } = await this.supabase
      .service()
      .from('media')
      .select('post_id, media_type, thumbnail_url, public_url, position, slot, deleted_at')
      .in('post_id', [...posts.keys()])
      .is('deleted_at', null)
      .order('position', { ascending: true });
    if (error) return;

    for (const row of (data ?? []) as unknown as Row[]) {
      const post = posts.get(String(row.post_id));
      if (!post || post.thumbnail_url) continue; // first one wins
      post.thumbnail_url = row.thumbnail_url ?? row.public_url ?? null;
      post.media_type = row.media_type ?? null;
    }
  }

  /**
   * Attaches the game a recruitment post recruits for. Only recruitment posts
   * carry one — there is no game dimension on ordinary posts, and inventing one
   * would put a filter in the console that the data cannot answer.
   */
  private async attachGames(posts: Map<string, Row>): Promise<void> {
    if (posts.size === 0) return;
    const { data, error } = await this.supabase
      .service()
      .from('recruitments')
      .select('post_id, game_id, status, games(id, name, short_name)')
      .in('post_id', [...posts.keys()]);
    if (error) return;

    for (const row of (data ?? []) as unknown as Row[]) {
      const post = posts.get(String(row.post_id));
      if (!post) continue;
      const game = row.games as Row | null;
      post.game_id = row.game_id ?? null;
      post.game_name = game ? (game.short_name ?? game.name ?? null) : null;
      post.recruitment_status = row.status ?? null;
    }
  }

  /** Best-effort display fields for a list of identity ids. */
  private async fetchIdentities(identityIds: string[]): Promise<Map<string, Row>> {
    const map = new Map<string, Row>();
    if (identityIds.length === 0) return map;
    const { data, error } = await this.supabase
      .service()
      .from('identities')
      .select(
        'id, kind, username, display_name, avatar_url, verified, premium, status, followers_count, following_count, created_at',
      )
      .in('id', identityIds);
    if (error) return map;
    for (const row of (data ?? []) as unknown as Row[]) map.set(String(row.id), row);
    return map;
  }
}

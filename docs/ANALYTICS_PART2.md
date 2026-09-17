# Esporta Analytics — Part 2: Aggregation & Metrics Engine

Status: **implemented**. Part 1 (event collection) is untouched; this layer
builds entirely on top of the immutable `analytics_events` ledger.

```
analytics_events (raw, append-only)
      │  analytics_aggregate_day(date)   ← cron-job.org, daily 00:15 UTC
      ▼
analytics_daily_entity      (one row per post/short per UTC day)
analytics_daily_identity    (one row per identity per UTC day)
analytics_daily_session     (one row per user per UTC day)
analytics_daily_reach       (daily distinct-viewer SETS behind reach)
      │  weekly/monthly derived from daily rows at read time
      ▼
/analytics/* (identity dashboards)  ·  /admin/analytics/* (future analytics-admin)
```

## 1. Aggregation design

**Recompute-and-replace, per UTC day bucket.** `analytics_aggregate_day(p_date)`
deletes the day's three rollup buckets and rebuilds them from the raw events of
`[p_date 00:00:00Z, p_date+1 00:00:00Z)` in ONE transaction. Consequences:

- **Idempotent.** Running the same day twice yields identical rows — verified
  by transactional probes (§6). Nothing is ever double-counted.
- **Late-arriving / out-of-order events** are absorbed by recomputing the day
  they belong to. The scheduled trigger reprocesses the trailing **7 days**
  every night, so a failed run, a delayed batch or a clock-skewed client
  self-heals within a day.
- **Deleted content.** Events keep being counted (they happened); ownership is
  re-resolved at aggregation time — a post hard-deleted before aggregation
  leaves `owner_identity_id`/`owner_user_id` null on its entity rows, so it
  drops out of owner-scoped reads but never corrupts totals.
- **Duplicates.** Ingestion (Part 1) dedupes on `client_event_id`; the
  aggregation therefore never sees the same qualifying event twice under the
  same id.
- **Timezone.** All day/week/month boundaries are **UTC**. Weeks are ISO 8601
  (Monday-start); months are calendar months. Fixed in code, not configuration.

`analytics_aggregate_range(from, to)` (≤ 92 inclusive days per call) and
`analytics_aggregate_recent(days ≤ 92)` exist for backfills. All three
functions are `SECURITY DEFINER`, executable by `service_role` only, with both
`search_path` and `TimeZone` pinned — `current_date` in the trailing-window
helper is therefore always the UTC date, not a property of whatever timezone
the connection happens to carry.

Weekly and monthly metrics are **derived from the daily rows** (in
`AnalyticsReadService`) — never recomputed from raw events per request. A
dashboard range read touches only a bounded, indexed slice of the daily layer.

### Additive vs distinct metrics

This split is the one thing to get right when extending the read layer:

- **Additive** (impressions, views, opens, reactions, comments, shares, saves,
  watch funnel, watch time, sessions, events, followers): summing the daily
  rows is correct.
- **Distinct** (reach, active users): summing is WRONG. A viewer who returns
  the next day is one account for the period but two daily rows, so a sum
  over-reports and — because reach is the engagement-rate denominator — also
  understates engagement rate. `analytics_daily_reach` therefore stores the
  daily distinct-viewer **sets**, and `analytics_reach` /
  `analytics_active_users` compute `COUNT(DISTINCT …)` in SQL over the
  requested range or bucket. Still daily-layer only; the raw ledger is never
  re-read for a dashboard request.

## 2. Metric semantics (frozen definitions)

| Metric | Definition | Source events |
|---|---|---|
| **impression** | One qualifying impression event. Part 1's client already enforces one per entity per 30-min window, so the ledger holds qualifying impressions. Post and short impressions share the column. | `post_impression`, `short_impression` |
| **view** | One qualifying view event (client: one per entity per session). | `post_view`, `short_view` |
| **open** | A deliberate open of the post detail. | `post_open` |
| **reach** | **Unique accounts** with ≥ 1 impression OR view in the period — a distinct count over `analytics_daily_reach`, never a sum of per-day reach and never impressions ÷ anything. `reach_users` on the daily rows is the per-DAY figure only. | filter over the impression/view set |
| **engagement** | reactions + comments + shares + saves. | `post_/short_reaction`, `post_/short_comment`, `post_/short_share`, `post_save` |
| **engagement rate** | engagement ÷ **reach** (unique accounts). The denominator is deliberately reach, fixed in `analytics-metrics.ts`; when reach = 0 the API returns `null`, not 0. | derived |
| **watch funnel** | `watch_starts` (watch opened), 25/50/75% milestones, `completes`. | `short_watch`, `short_watch_25/50/75`, `short_complete` |
| **watch time** | Sum of `properties.watch_time_ms` across `short_watch*` **and** `short_complete` events, clamped to [0, 3,600,000] ms per event. | `short_watch*`, `short_complete` |
| **followers gained/lost** | Follow/unfollow events targeting the identity. | `follow`, `unfollow` (entity_type `identity`) |
| **profile views** | Views of the identity's profile (personal and team views). | `profile_view`, `team_view` |
| **sessions** | Distinct `session_id`s observed that day (per user; per identity on the identity row). | any events |
| **recruitment** | `applications_submitted` / `hire_requests_made` (actor side); recruitment impressions/views on the owning content. | `application_created`, `hire_request_created`, `recruitment_impression`, `recruitment_view` |

Identity attribution: every event carries the **active identity**
(`actor_identity_id`, validated by `can_act_as`), so personal vs team activity
aggregates separately by construction.

## 3. API contracts

Envelope is the standard `{ success, data, error, meta }`. All date params are
inclusive UTC `YYYY-MM-DD`; spans are capped at 366 days. `granularity` is
`day` (default) | `week` | `month`.

### Identity dashboards (Flutter: personal AND team — same contract)

| Endpoint | Returns |
|---|---|
| `GET /api/v1/analytics/overview?from&to&granularity` | `totals` (impressions, views, opens, reactions, comments, shares, saves, reach, engagement, engagement_rate), `followers` {gained, lost, net}, `profile_views`, `watch` funnel, `sessions`, `events`, `recruitment` {applications_submitted, hire_requests_made, impressions, views}, and `series` (impressions, views, reach, engagement, followers_gained/lost, profile_views, watch_time_ms, sessions) |
| `GET /api/v1/analytics/top-content?from&to&kind=post\|short&limit` | Top content ranked by views (tie-break engagement), each with totals (incl. exact reach + engagement_rate), the `post` display row, and a `posts` map |
| `GET /api/v1/analytics/content/:entityId?from&to&granularity` | One own content's totals, watch funnel, `recruitment` {impressions, views} and series (owner-only) |

Scope = the active identity from `X-Active-Profile-Id` (validated with
`can_act_as`). A user switching to a team in the app switches the dashboard.
`content/:entityId` answers **404** for content that is not the active
identity's — the same answer as "no data", so the route cannot be used to probe
which posts exist or which ones get traffic.

### Future analytics-admin (Part 3 UI consumes; no UI built here)

| Endpoint | Returns |
|---|---|
| `GET /api/v1/admin/analytics/overview?from&to&granularity` | Platform totals (sessions, events, active_users, content impressions/views, profile views, reach) + series (incl. `active_users`). `active_users` and `reach` are exact distinct-account counts. |
| `GET /api/v1/admin/analytics/top-identities?from&to&limit` | Top identities ranked by exact period reach, with impressions/views/profile views/follower gains |

Both sit behind `AdminGuard`. If per-capability gating is wanted later, an
`analytics.view` capability can be added without changing these contracts.

### Scheduling (external — cron-job.org)

The aggregation is triggered by an **external scheduler**, not Vercel Cron.
`vercel.json` carries no `crons` entry; there is no in-process scheduler and no
background worker. The endpoint stays, protected, and one authenticated request
a day is the whole mechanism:

```
cron-job.org  →  authenticated HTTPS request
              →  GET /api/v1/webhooks/internal/analytics-aggregate
              →  analytics_aggregate_recent(7)
              →  Supabase daily analytics rollups
```

**cron-job.org job configuration**

| Setting | Value |
|---|---|
| Method | `GET` |
| URL | `https://<your-vercel-domain>/api/v1/webhooks/internal/analytics-aggregate` |
| Schedule | Every day at **00:15 UTC** (`15 0 * * *`) — 06:15 Asia/Dhaka |
| Job timezone | **UTC** (set it explicitly; do not use Asia/Dhaka with 06:15) |
| Executions | **1 per day** |
| Header | `x-dispatch-secret: <the push_dispatch_secret value>` |
| Timeout | 30 s (matches the function's `maxDuration`) |
| Treat as success | HTTP 200 |

The secret is the `push_dispatch_secret` row in `private.app_secrets` — the same
value the pg_net push dispatcher sends. It is verified by the
`verify_dispatch_secret` RPC, so it never leaves Postgres and is not an
environment variable of the API. Nothing else authenticates this route: without
the header the endpoint answers `401 UNAUTHENTICATED` and does no work.

`Authorization: Bearer <secret>` is still accepted as an alternative for
schedulers that cannot set custom headers. Prefer `x-dispatch-secret` on
cron-job.org, which can.

**Why once a day is enough.** Each run recomputes the trailing 7 UTC days, so a
missed night, a delayed batch or a clock-skewed client is repaired by the next
run — the window is the retry policy. Ops can still backfill on demand:

```
POST /api/v1/webhooks/internal/analytics-aggregate
x-dispatch-secret: <secret>
{"days": 30}          # 1–92
```

## 4. Storage & access control

- Rollup tables (`analytics_daily_entity`, `_identity`, `_session`, `_reach`):
  RLS **enabled with zero policies** and all client privileges revoked —
  clients cannot read or write them; reads flow through the backend (service
  role, strictly server-scoped) and writes only via the aggregation functions.
  The Supabase linter reports these as `rls_enabled_no_policy` (INFO); that is
  the intended deny-all posture, not a finding.
- Indexes: `(stat_date, …)` uniques plus `(entity_id, stat_date)`,
  `(owner_identity_id, stat_date)`, `(identity_id, stat_date)`,
  `(user_id, stat_date)` for range reads. `analytics_daily_reach` is keyed
  `(scope, scope_id, stat_date, user_id)` for one-subject lookups, with a
  `(scope, stat_date, scope_id, user_id)` index for the platform-wide and
  top-identities sweeps.
- Read helper functions (`analytics_reach`, `analytics_reach_top`,
  `analytics_active_users`): `SECURITY DEFINER`, `service_role` only, with
  `search_path` and `TimeZone` pinned.
- Raw ledger untouched: still append-only, still invisible to client reads.

## 5. Files

```
src/analytics/
├── analytics-aggregate.service.ts   # trigger for the SQL aggregation (cron/backfill)
├── analytics-read.service.ts        # dashboard reads + weekly/monthly derivation
├── analytics-read.service.spec.ts   # Jest: additive-vs-distinct arithmetic, scoping, 404s
├── analytics-metrics.ts             # PURE metric semantics (bucketing, rates) — unit tested
├── analytics-metrics.spec.ts        # Jest: bucketing, engagement rate, ranges
├── admin-analytics.controller.ts    # /admin/analytics/* (AdminGuard)
├── analytics.controller.ts          # + GET overview / top-content / content/:id
└── dto/analytics-query.dto.ts       # from/to/granularity/limit validation
```

## 6. Verification performed

- **Live-DB transactional probes** (seed inside `begin…rollback`, aggregate,
  assert, re-aggregate, compare checksums, rollback — zero residue):
  - 26/26 assertions PASS after fixes: post + short entity metrics, full watch
    funnel, watch time incl. completion (35,000 ms case), team identity
    attribution (team row resolves `user_id` to its owner), actor-side
    identity metrics, unique reach (2 impressions from 2 users → reach 2),
    session dedupe (2 `app_open` in one session → 1 session), UTC date
    boundary (23:59:59Z vs 00:00:00Z land on different days), and
    byte-identical rollups after a second identical aggregation run.
  - Two real bugs found and fixed by the probe before they could ship:
    short impressions/views excluded from their own entity row, and
    `short_complete`'s watch time excluded from the total.
- `tsc --noEmit` clean; `npm test` (Jest) green.

### 6.1 Post-audit correction round

A later audit re-probed the same way and found the aggregation itself correct
(idempotent, UTC-exact, correct funnel/watch time, correct personal-vs-team
attribution) but the READ layer summing two distinct-count metrics. Fixed and
re-verified:

- Entity reach over a 2-day range with one returning viewer: summed **4** →
  exact **3**, matching a raw `count(distinct actor_user_id)` ground truth.
  Engagement rate moved from 0.5000 (inflated denominator) to 0.6667.
- `active_users` over the same range: summed `active_identities` **4** → exact
  distinct users **3**.
- Week/month reach buckets are counted per bucket, not summed across days.
- Reach membership is idempotent across re-runs (`begin…rollback` snapshot
  comparison identical).
- `analytics_aggregate_range` now rejects a 93-day span and accepts 92.
- `analytics_aggregate_recent(7)` executed against the live database returns
  the correct UTC trailing window.
- Endpoint auth verified locally on the built app: missing secret, wrong
  `x-dispatch-secret` and wrong `Authorization: Bearer` all answer
  `401 UNAUTHENTICATED` and perform no work; both `/analytics/*` and
  `/admin/analytics/*` answer 401 without a JWT.
- 30/30 Jest tests green (12 metric + 18 new read-layer regression tests whose
  fixtures deliberately make a summed reach differ from the true distinct
  count, so a regression fails loudly).

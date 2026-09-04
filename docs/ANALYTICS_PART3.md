# Esporta Analytics — Part 3: Presentation / Consumption Layer

Status: **implemented**. Parts 1 (event collection) and 2 (aggregation &
metrics) are untouched in behaviour. Part 3 adds the dashboards that read them —
a Flutter identity dashboard (personal + team), an `analytics-admin` Next.js
console, and the minimum backend read APIs those two surfaces required.

> **Recommendation Engine was NOT implemented in Part 3.** No feed ranking,
> recommendation scores, category boosting, ML, or admin recommendation
> controls were added. The analytics contracts below are designed so a future
> engine can consume the same signals without a rewrite.

```
Flutter dashboard ─┐
                   ├─→  /api/v1/analytics/*         (identity-scoped, ActiveProfileGuard)
analytics-admin ───┘    /api/v1/admin/analytics/*   (platform-wide, AdminGuard)
                              │
                        AnalyticsReadService  (one calculation path, both surfaces)
                              │
                        daily rollups + SQL read fns  (Part 2 data, never the raw ledger)
```

## 1. Backend changes

### 1.1 New SQL read functions (live-DB migrations)

All are `STABLE SECURITY DEFINER`, `search_path`/`TimeZone` pinned, and
**`service_role`-only** — the same posture as the Part 2 functions. They exist
because PostgREST cannot `GROUP BY`, so ranking/pagination/platform aggregation
must happen in SQL rather than by shipping the whole daily layer into Node and
computing in JavaScript (which both breaks at scale and risks silent truncation
against the API row cap).

| Function | Purpose |
|---|---|
| `analytics_entity_top(from,to,owner,kind,order,limit,offset)` | Top posts/shorts ranked by views/reach/engagement/impressions/watch_time/completion. `owner` null ⇒ platform-wide; non-null ⇒ that identity's own content. Returns `total_count` for pagination. |
| `analytics_identity_top(from,to,kind,order,limit,offset)` | Top identities ranked by reach/views/impressions/engagement/profile_views/followers/watch_time, filterable by personal/team, with `total_count`. |
| `analytics_platform_totals(from,to,granularity)` | Platform totals + per-bucket series, aggregated in SQL. Replaces the Part-2 admin read that summed unbounded PostgREST selects in Node (which could under-report past the row cap). |

**Migrations applied:** `analytics_part3_leaderboard_reads`,
`analytics_part3_leaderboard_reads_lockdown`, `analytics_part3_platform_totals`,
`analytics_part3_platform_totals_lockdown`. The two `_lockdown` migrations
revoke the default `PUBLIC`/`anon`/`authenticated` execute grants that a freshly
created function carries — without them the leaderboards would have been
client-callable, defeating the deny-all posture on the rollup tables. All nine
`analytics_*` functions are now verified `service_role`-only.

**Additive-vs-distinct rule preserved:** reach stays a `COUNT(DISTINCT …)` over
`analytics_daily_reach`; it is never summed. The new functions rank by exact
reach where asked, and `analytics_platform_totals` deliberately omits reach and
active users (those keep going through `analytics_reach` /
`analytics_active_users`).

### 1.2 Read service (`analytics-read.service.ts`)

- `overview` and `adminOverview` gained an optional **`compare`** flag: when set,
  the equal-length preceding window is fetched and returned as `previous` plus a
  `changes` map of `{current, previous, absolute, percent}`. `percent` is `null`
  when the previous period was 0 — growth from nothing has no percentage.
- `topContent` / `adminTopContent` and `adminTopIdentities` now delegate to the
  SQL functions (ranking/paging/filtering pushed down), and attach display rows
  (`posts`, `identities`).
- New `adminContentDetail` (platform scope) and completion-rate/watch derivation
  are done in the service, so the UI never computes a rate.
- `adminOverview` now also returns all-time `total_users`/`total_teams` and
  range-scoped `posts_published`/`shorts_published`, clearly separated from
  "active in this period".

### 1.3 New routes

| Route | Guard | Returns |
|---|---|---|
| `GET /api/v1/admin/me` | AdminGuard | The `admin_me` payload, so a console can authorize through the backend instead of holding a DB client. |
| `GET /api/v1/admin/analytics/top-content` | AdminGuard | Platform top posts/shorts. |
| `GET /api/v1/admin/analytics/content/:entityId` | AdminGuard | One content item, platform scope. |

Existing routes gained parameters (all backward-compatible — the Part-2 response
shape is a subset of the new one): `overview`/`admin/analytics/overview` accept
`compare`; `top-content` accepts `order`/`offset`; `admin/analytics/top-identities`
accepts `identityType`/`order`/`offset`.

### 1.4 DTO validation fix

The Part-2 `top-content` handler used a TypeScript intersection type for its
query, which made Nest's `ValidationPipe` skip validation entirely (it emits
`Object` metadata). Part 3 replaced these with real DTO classes
(`AnalyticsOverviewQueryDto`, `AnalyticsTopContentQueryDto`,
`AnalyticsTopIdentitiesQueryDto`), so `from`/`to`/`limit`/`order`/`offset` are
now validated on every analytics read.

## 2. Flutter — identity dashboard (Part 3A)

**Entry points:** four, and every one opens `AnalyticsDashboardScreen`:
- `Profile → (insights icon)` on your own personal profile;
- `Settings → Insights → Dashboard` (the account settings page);
- `Team profile → (insights icon)` on your own team, and
- `Team settings → Insights → Dashboard`.

The two team entry points appear only while that team is the ACTIVE profile
(`IdentityController.active.value.id == team.id`). The dashboard is scoped
server-side to `X-Active-Profile-Id`, so an owner browsing their team from their
personal profile would otherwise be handed personal numbers under the team's
header; in team settings the row stays visible but inert and says to switch
profile, rather than disappearing with no explanation.

**Personal vs team isolation** — the load-bearing requirement:
- The screen is keyed `ValueKey('analytics-<activeId>')`, so a profile switch
  disposes the subtree and builds a fresh one.
- `AnalyticsDashboardController` listens to `IdentityController.active` and, on
  any switch, clears cached state and bumps a token so an in-flight response for
  the old identity is discarded.
- `stateFor(identityId)` refuses to return a payload whose owner is not the
  identity being rendered, closing the one-frame gap between a switch and the
  listener firing.

**Data source:** `AnalyticsRepository` is **backend-only** — no Supabase
fallback, because the rollups are not client-readable and a fallback would be a
second implementation of frozen metrics. Identity scoping is implicit via the
`X-Active-Profile-Id` header the shared `ApiClient` already attaches.

**Screens:** overview (KPI cards with period comparison, time-series charts,
audience/follower bars, watch funnel, top posts, top shorts, recruitment) and a
per-content detail screen that can open the real post/short.

**Charts:** hand-painted with `CustomPainter` (no charting package is a
dependency). They handle empty / single-point / all-zero / sparse / large-value
series and never overflow (LayoutBuilder grid, Wrap, FittedBox, ellipsis).

**Theme:** the app is dark-only (`main.dart`: "Dark is the only theme"). Every
surface uses the semantic `context.colors.*` tokens — no hardcoded colours — so
the dashboard is automatically correct if a light theme is ever introduced.

## 3. analytics-admin (Part 3C)

A standalone Next.js 16 (App Router, React 19, TypeScript) console — separate
from `core-admin`. Stack: Tailwind v4, shadcn/ui-style primitives, Recharts,
TanStack Table. See `analytics-admin/README.md` for setup and deploy.

- **Auth:** Supabase Auth for the session (browser), forwarded as a bearer to
  the backend. `requireAdmin()` calls `GET /admin/me`; AdminGuard is the
  boundary. **No** service-role key, DB URL, or provider secret is present — the
  three env vars are all browser-safe (`NEXT_PUBLIC_SUPABASE_URL/ANON_KEY`,
  `NEXT_PUBLIC_API_URL`).
- **Pages:** `/overview` (platform KPIs + comparison + time series),
  `/identities` (ranked, type-filtered, paginated table), `/content` (ranked,
  kind-filtered, paginated), `/content/[entityId]` (per-item detail + funnel).
- **No client-side aggregation:** sorting, filtering and pagination all write
  URL params and re-fetch a finished page from the backend.
- **No fake filters:** only filters the backend actually supports (identity
  type, content kind, ranking dimension, date range) are offered — there is no
  game/category filter because that dimension is not in the analytics data.

## 4. Verification

- **Backend:** `tsc --noEmit` clean; **59/59 Jest** tests green (was 30 — added
  period-comparison, completion-rate, SQL-pushdown, platform-aggregation and
  admin-content-detail coverage). 179 routes map on boot; every analytics route
  answers `401` without a JWT.
- **Data correctness (live-DB `begin…rollback` probe, zero residue):** **20/20**
  assertions PASS, including the spec's exact case — **2 users × 4 impressions →
  impressions = 4, reach = 2** (with a proof that the naive daily-sum would give
  4), views kept separate, engagement rate = engagement ÷ reach, short watch
  time = 35000 incl. `short_complete`, identity `kind` resolved, and
  weekly/monthly buckets equal to the day sums for a single-week range.
- **Flutter:** `flutter analyze` clean on all analytics files; the pure
  model/format/range logic executed via a standalone Dart run — **20/20** checks
  PASS (null engagement-rate preserved, null percent from zero baseline, deleted
  content unopenable, compact counts, duration formatting, range clamping).
  `flutter test` cannot execute in the Termux/arm64 dev environment
  (`flutter_tester` cannot link `libvk_swiftshader.so`); the widget/unit test
  file `test/analytics_test.dart` is committed and analyze-clean for CI.
- **analytics-admin:** `tsc --noEmit` clean; production build succeeds; the proxy
  redirects unauthenticated visitors (`/` and `/overview` → `/login`, with an
  open-redirect-safe `next`) and `/login` renders `200`.

## 5. Recommendation-engine compatibility (design only)

Nothing engine-related was built. The Part 3 work keeps every signal a future
engine needs intact: reach/impressions/views stay distinct, the short watch
funnel is preserved, identity and content attribution are preserved, daily
historical aggregates are untouched, and both content- and identity-level
metrics are queryable through stable, versioned read functions. Adding an engine
later can consume these without redesigning analytics.

## 6. Known limitations

- Turbopack production builds need native bindings absent on `android/arm64`;
  build locally with `npm run build:webpack`. Vercel (x64) uses the default
  Turbopack build unchanged.
- The analytics tables are currently empty in the live project, so dashboards
  render their (correct) empty states until the daily aggregation has data.
- No dedicated `analytics.view` admin capability exists yet; the admin surface
  gates on `AdminGuard` alone. A capability can be added later without changing
  any contract (a `gate()` helper is already in place in analytics-admin).

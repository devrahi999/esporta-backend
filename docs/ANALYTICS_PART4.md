# Esporta Analytics — Part 4: The Analytics Control Centre

Status: **implemented**. Parts 1 (event collection) and 2 (aggregation &
metrics) are untouched in behaviour. Part 3's read layer is extended, never
replaced. This part turns the `analytics-admin` console from four pages of
headline numbers into a multi-section control centre, and adds the smallest set
of backend reads that made it possible.

> **The Recommendation Engine was NOT implemented.** No feed ranking, no
> recommendation scores, no category boosting, no ML, no admin recommendation
> controls. Every signal a future engine needs is preserved unchanged — see §6.

```
analytics-admin (9 pages + CSV export)
        │  Supabase JWT as bearer
        ▼
/api/v1/admin/analytics/*   (AdminGuard)
        │
AnalyticsReadService        (one calculation path, shared with the Flutter dashboards)
        │
16 SQL read functions       (daily rollups + transactional composition; never the raw ledger)
```

## 1. The development watcher failure, and the fix

### Root cause

Running the console's dev server on the Termux/`android/arm64` development host
produced a flood of

```
Watchpack Error (watcher): Error: ENOSPC: System limit for number of file watchers reached, watch '…/src'
Watchpack Error (watcher): Error: EACCES: permission denied, watch '/data/data'
⨯ The directory at "…/analytics-admin" was deleted. Restarting the server to recover...
```

Three symptoms, one cause, in this order:

1. **The inotify budget on this host is effectively one watch.** A probe that
   opens `fs.watch` on 4,000 real directories succeeds **once** and then throws
   `ENOSPC`. `/proc/sys/fs/inotify/max_user_watches` is not readable on Android,
   so this is not something a config file can be consulted about. A webpack dev
   server needs dozens.

2. **The parent-directory walk is Watchpack escalating on failure.** Next's own
   dev-server watcher registers the project directory and `.next` as *missing*
   paths (`start-server.js`, so it can notice `next.config.ts` changing or the
   project being deleted), which by design watches the project's parent. When
   each of those watches fails, Watchpack falls back to the next parent up —
   `~/Esporta` → `~` → `/data/data/com.termux/files` → `/data/data` → `/data` —
   and Android denies the last two with `EACCES`.

3. **The restart loop is that failure being misread.** With its watcher broken,
   Watchpack reports the project directory as *removed*, and Next concludes the
   directory was deleted and restarts — forever.

A second, independent limit was also in the way: `next dev` defaults to
Turbopack, which has no `android/arm64` native bindings and aborts outright. The
developer had been falling back to `next dev --webpack` by hand, which is how the
Webpack watcher was in play at all.

### Fix

Nothing was disabled. `next.config.ts` became a phase-aware config that, **in
the development-server phase only**:

- **probes the host's real inotify budget** — it opens watches on up to eight
  real project directories and counts how many survive, then closes them all.
  One watch succeeding proves nothing on this host, which is exactly the trap a
  naive `fs.watch(root)` smoke test falls into, so the bar is eight;
- **switches to polling when the probe fails**, by setting both
  `watchOptions.pollIntervalMs` (Next's first-class option, which reaches the
  webpack compiler's watcher) and `process.env.WATCHPACK_POLLING` (which
  Watchpack reads at module load and applies to **every** watcher in the
  process — including Next's internal one, the source of the bogus
  "directory was deleted" loop). Polling uses **zero** inotify watches and keeps
  hot reload working;
- **bounds the watch set to the project directory**, by merging an
  "outside the project root" pattern into webpack's `watchOptions.ignored`
  (as one RegExp — webpack's schema rejects a mixed list). This keeps the long
  tail of non-existent `node_modules` resolution candidates from pulling
  ancestors into the watch set;
- **leaves healthy hosts alone.** When the probe succeeds, none of the above is
  applied and native watching keeps its speed. `NEXT_WATCH_POLL=1|0` forces the
  decision either way; `NEXT_WATCH_POLL_MS` tunes the interval.

`package.json` gained `dev:webpack`, mirroring the existing `build:webpack`
convention, so the platform's Turbopack limitation has a named escape hatch
instead of a remembered flag.

Production is untouched: the polling branch is gated on the dev-server phase, and
the `ignored` merge is gated on `dev`, so `next build` and `next start` behave
exactly as before.

### Verified

| Check | Result |
|---|---|
| `ENOSPC` occurrences in a dev run | **0** (was 190 in a 120-second run) |
| `EACCES` watcher/scandir errors | **0** |
| "directory was deleted" restart loop | **gone** |
| Watches on `~/Esporta`, `~`, `/data/data`, `/data` | **gone** |
| Hot reload | **works** — editing a Server Component's markup and re-requesting the page served the new markup with no restart |
| `next build --webpack` | **succeeds**, 13 routes |

One benign warning remains and is **not** caused by this change:
`[webpack.cache.PackFileCacheStrategy] Caching failed for pack: Unable to
snapshot resolve dependencies`. It appears identically in `next build` and in a
dev run with the watch changes disabled; it only means webpack's persistent cache
is not written on this filesystem.

## 2. Backend: new SQL read functions

Eight migrations. Every function is `STABLE SECURITY DEFINER` with `search_path`
and `TimeZone` pinned, and **`service_role`-only** — all 16 `analytics_*`
functions were re-verified to carry no `anon`/`authenticated`/`PUBLIC` execute
grant. Each freshly created or recreated function got an explicit revoke, because
a new function inherits a default `PUBLIC` grant that would make it callable by
any signed-in user.

| Migration | Change |
|---|---|
| `analytics_part4_platform_totals_v2` (+ `_lockdown`) | Widened `analytics_platform_totals` with `follows_made`, `unfollows_made`, `applications_submitted`, `hire_requests_made`, `recruitment_impressions`, `recruitment_views`, `active_identities`, `content_items`. |
| `analytics_part4_entity_top_orders` | `analytics_entity_top` gained `opens`, `reactions`, `comments`, `shares`, `saves` orderings, so "most commented" and "most saved" are real SQL leaderboards. Return type unchanged ⇒ `CREATE OR REPLACE`, grants preserved. |
| `analytics_part4_identity_top_v2` (+ `_lockdown`) | `analytics_identity_top` gained the engagement breakdown, the watch funnel, `content_count`, and `content` / per-component orderings. |
| `analytics_part4_platform_growth` | New: signups and publications per bucket, from `identities` / `posts`. |
| `analytics_part4_audience_split` | New: `active_users` / `returning_users` / `new_users` as distinct counts, where returning means "also seen before the window". |
| `analytics_part4_content_dimensions` | New: `analytics_content_distribution` (format / author kind / media / post type, long format) and `analytics_reaction_mix` (per reaction type). |
| `analytics_part4_freshness` | New: newest aggregated day and last aggregation timestamp per rollup layer. |
| `analytics_part4_platform_size` | New: all-time users, teams, posts, shorts, videos, images in one call — replacing four PostgREST `head` counts and making "videos" expressible at all (it needs a join). |

### The two distinct-metric additions

`active_identities` and `content_items` are `count(distinct …)` **per bucket**,
never sums — the same rule that keeps reach honest.
`analytics_daily_session.active_identities` was deliberately not used for the
former: it counts identity-activations per user-day, so summing it answers a
different question.

### Where a metric could not come from the rollups

The reaction **mix** (love / fire / laughing / angry) is the one requested
breakdown the aggregation layer cannot answer:
`analytics_daily_entity.reactions` is a single untyped count, and the ledger's
reaction events carry no reaction type either. Rather than change the frozen
aggregation, `analytics_reaction_mix` reads the authoritative taxonomy
(`reaction_types`) and the `reactions` table, scoped by `reactions.created_at`.

That answers a *different* question — reactions **created in the window that
still stand**, versus the rollup's reaction **events** — so the API labels it
(`scope.source = 'reactions_standing'`) and every surface that renders it says so
in prose. It is never presented as a decomposition of the engagement total.

## 3. Backend: read service, DTOs, routes

`analytics-read.service.ts`:

- `adminOverview` now returns four separated blocks — `platform` (all-time
  composition, no comparison), `totals` (range-scoped, flat and identically
  shaped for the current and previous window), `derived` (server-computed
  averages and ratios), and `series` (24 series from three SQL calls). `changes`
  is generated by diffing the two totals maps, and deliberately **skips
  `engagement_rate`**: the percentage change of a percentage is not a number a
  card should show.
- New `adminIdentityDetail` — one identity's full analytics, platform scope,
  reusing the same `identityWindow` the Flutter dashboard calls, so an operator
  and a creator see identical numbers. 404s for an unknown identity before any
  rollup is read.
- New `adminReactionMix`, `adminContentDistribution`, `adminFreshness`.
- `adminContentDetail` gained the reaction mix and a `derived` ratio block.
- `fetchPosts` now attaches a thumbnail (lowest-position surviving attachment,
  preferring a video's poster frame) and the game a recruitment post recruits
  for — three bounded `in (…)` lookups over one page of ≤ 100 ids, all
  best-effort so a failed decoration can never fail a dashboard.
- `ratioOf` in `analytics-metrics.ts` is the single place every average and ratio
  is computed, so the zero-denominator answer is `null` everywhere.

DTOs: `CONTENT_ORDERS` 6 → 11, `IDENTITY_ORDERS` 7 → 12, new
`AnalyticsReactionMixQueryDto` with uuid-validated optional scopes.

New routes, all behind `AdminGuard`:

| Route | Returns |
|---|---|
| `GET /api/v1/admin/analytics/freshness` | Aggregate mode, last processing time, newest complete day, staleness. |
| `GET /api/v1/admin/analytics/identity/:identityId` | One identity's full analytics. |
| `GET /api/v1/admin/analytics/reaction-mix` | Reaction mix, optionally scoped to one item or one author. |
| `GET /api/v1/admin/analytics/distribution` | Published-content breakdowns. |

Existing routes kept their contracts; the Part 3 response shapes are subsets of
the new ones except for the overview, whose all-time counts moved from `totals`
into the new `platform` block — the console is the only consumer.

## 4. analytics-admin: the console

Nine pages, organised by question rather than by table, plus a server-side CSV
export. Full route table and metric semantics: `analytics-admin/README.md`.

Decisions worth recording:

- **URL is the state.** Window, granularity, ranking dimension, format, identity
  type and page all live in the query string, so a view is shareable and the back
  button works. Presets are stored by name (`preset=7d`) so a bookmark still
  means "the last 7 days" tomorrow.
- **One request per screen, not per widget.** The overview's 40 tiles, 24 series
  and 5 charts come from two calls (`overview` + `freshness`). Switching the
  charted metric is local state over data already in hand.
- **No shared cache for authorized reads.** `fetch` stays `cache: 'no-store'`:
  Next's Data Cache is shared across requests, and caching an authorized response
  there would put one operator's answer where another request could be served
  from it.
- **Nothing computed in the browser.** Rates, averages and ratios come from
  `derived`. The single exception is a watch-funnel step's share of watches
  started — two counts from the same response — and it returns null at zero
  starts like everything else.
- **Two themes.** Light and dark are both first-class, applied as a class on
  `<html>` by a pre-paint inline script so there is no flash. Charts read the
  active theme from context and pick concrete colours, because Recharts writes
  colours as SVG attributes where `var()` is unreliable.
- **Skeletons match geometry.** Each `loading.tsx` mirrors its page's grid, tile
  height and row count, so nothing jumps when data lands.
- **Empty is not broken.** "No analytics data yet" is a distinct state from
  "could not load", which is distinct from "not available to your role". When the
  whole window reads zero, the overview says whether that is an empty pipeline or
  a quiet week, using the freshness read.
- **CSV export is server-side**, downloads exactly the current filtered view, and
  is capped at 1,000 rows (20 backend pages). Fields are written as raw numbers,
  `null` as an empty cell, and formula-prefixed text is neutralised against CSV
  injection. There is no raw-event export.

## 5. Verification performed

**Live-DB controlled-data probe** — seeds a two-day scenario, aggregates,
asserts, then aborts the transaction so nothing persists (rollup and event tables
re-confirmed at 0 rows afterwards): **27/27 PASS, 0 FAIL**, including

- 2 accounts × 4 impressions + 1 returning impression → **impressions 5, reach 2**,
  with the naive daily sum (3) computed alongside to prove reach is not a sum;
- views **1** and impressions **5** stay separate numbers;
- engagement **4** = 1 reaction + 1 comment + 1 share + 1 save; rate = 4 ÷ 2 = **2.0**;
- short watch funnel 1/1/1/1/1 and watch time **35,000 ms** including the
  completion event's contribution;
- `content_items` **2** and `active_identities` **2** as distinct counts;
- audience split over both days **2 active / 0 returning / 2 first-seen**, and
  over day 2 alone **1 / 1 / 0** — the returning classification working;
- `analytics_active_users` agreeing with `analytics_audience`;
- weekly and monthly buckets equal to the day sums, and weekly reach counted per
  bucket (2, not 3);
- `analytics_entity_top` returning 2/5/1/4 for the seeded post, `order=saves`
  ranking it first, and `kind=short&order=completion` ranking the short first;
- `analytics_identity_top` returning reach/views/engagement/content_count
  2/1/4/2 for the author;
- freshness reporting the newest aggregated day;
- a second identical aggregation run leaving the totals unchanged.

**Backend** — `tsc --noEmit` clean; **85/85 Jest** green (was 71, of which 3 had
to be updated for the new overview shape; 14 new tests cover the audience split,
the derived block, the null-denominator rule, the rate excluded from `changes`,
the zero-baseline percent, freshness staleness, the reaction-mix source label and
uuid rejection, the distribution grouping, and identity-detail scoping and 404s).
All 193 routes map on boot; all 9 admin analytics routes answer **401** without a
JWT.

**analytics-admin** — `tsc --noEmit` clean; `next build --webpack` succeeds with
13 routes; every page and both export routes redirect a signed-out visitor to
`/login` with an open-redirect-safe `next`, and `/login` renders 200.

**Development** — 0 `ENOSPC`, 0 `EACCES`, no restart loop, hot reload verified
end to end on the final source tree.

## 6. Recommendation-engine compatibility (design only)

Nothing engine-related was built. Every signal a future engine would consume is
intact and now easier to inspect: reach, impressions and views remain three
distinct metrics; the short watch funnel and watch time are unchanged; identity
and content attribution are unchanged; the daily historical layer is unchanged;
and both content- and identity-level metrics are queryable through stable,
`service_role`-only read functions. No recommendation score exists, and no feed
ranking was touched.

## 7. Known limitations

- **The analytics tables are empty in the live project.** No aggregation run has
  produced a day, so every measured figure renders its (correct) empty state.
  The console distinguishes this from a quiet window rather than showing zeros.
- **Reaction, comment, share and save events are never emitted by the Flutter
  app.** The taxonomy and the aggregation both handle them, but no call site
  calls `AnalyticsService.track` with them, so those rollup columns will stay 0
  until the app emits them. The reaction *mix* is unaffected — it reads the
  `reactions` table.
- **Turbopack cannot build or serve on `android/arm64`;** use the `:webpack`
  scripts there. Vercel (x64) is unaffected.
- **The webpack persistent cache does not write on this filesystem** (the
  "Unable to snapshot resolve dependencies" warning). Cosmetic; compilation and
  hot reload work.
- **CSV export is capped at 1,000 rows.** A larger export needs a streaming
  backend endpoint, not a longer loop in a route handler.
- **No `analytics.view` capability exists**; the admin surface still gates on
  `AdminGuard` alone. A `gate()` helper is in place for when one is added, and no
  contract changes when it is.
- **There is no game or category dimension on ordinary posts.** Only recruitment
  posts carry a game, so the console shows the game as a badge where it exists
  and offers no game filter — the data cannot answer one.

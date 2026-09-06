# Recommendation & Ranking Engine — Phase 1

Built 2026-09-06. The centralized, deterministic, configuration-driven ranking
engine that powers Home Feed, Shorts and Search, designed from day one for the
Phase 2 Recommendation Admin Panel.

**No ML, no embeddings, no external services** — SQL feature rollups + typed
TypeScript scoring. Everything is explainable, versioned and bounded.

---

## Architecture

```
Analytics (existing ledger + daily rollups)
        │
        ▼
reco_rebuild_all  (nightly, idempotent recompute-and-replace)
  ├─ reco_content_features    per-post quality/engagement/watch/negative
  ├─ reco_identity_features   per-identity (person AND team) quality/activity
  ├─ reco_user_features       viewer tendencies + cold-start flag
  ├─ reco_user_topic_affinity viewer→game/type/role  (dimension:game|content_type|role)
  ├─ reco_user_identity_affinity  viewer→identity, SIGNED (negative demotes)
  └─ prunes reco_exposure_log (30-day ring buffer)
        │
        ▼  per request (service role)
reco_candidates  — layer 1: candidate ids by source, hard eligibility applied
        │
        ▼
reco_ranking_inputs — ONE round trip: viewer + content + affinities +
        │             interventions + exposures for the whole pool
        ▼
Ranker (FeedRanker | ShortsRanker | SearchRanker)  — weighted, normalised,
        │                                          explainable components
        ▼
applyExploration → DiversityReranker → slate (≤300 ids)
        │
        ▼  caller-scoped fetch (RLS decides!)
PostsService.byIds / search hydration
```

### The two-layer eligibility contract (the security design)

Ranking runs on the **service role** — it must, because the feature tables hold
every user's interest graph and no client role may read them. Ranking therefore
returns **ordered post IDS, never content**. The surface then fetches those ids
with the **caller's own client**, where RLS (`posts readable by visibility`,
`identities readable unless deleted`) decides what is actually returned.

- Layer 1 (`reco_candidates`): deleted posts/identities, restricted authors,
  blocks (both directions), moderation-removed posts, shorts with no live video.
  Plus a visibility predicate as a pool-quality optimisation.
- Layer 2 (caller-scoped `byIds`): the authoritative check. An id the viewer may
  not see yields no row — silently.
- Layer 3 (config-derived, can only be stricter): negative-rate ceiling,
  exposure-count drop, features-missing drop.

A ranking bug, a mistuned weight, an admin boost or an exploration slot can
mis-ORDER a feed but can never LEAK content. Config cannot widen eligibility
because no eligibility rule is a config value.

### Identity-centric model

Identity affinity (`reco_user_identity_affinity`) and content interest
(`reco_user_topic_affinity`) are **separate tables and separate score
components** — "by someone you follow" and "about a game you play" stay
individually observable in every explanation. Identity features cover personal
AND team identities in one computation, so future "Recommended
Players/Teams/Coaches" surfaces rank on the same model without a new pipeline.

Self-content policy (§45): own content is eligible and ranked (bounded
`ownContent` weight, never auto-#1), and an actor's events on their own
content/profile NEVER enter the interest model — enforced in SQL at the source,
not in candidate queries.

## Surfaces

| Surface | Objective | Notes |
|---|---|---|
| Feed | relevance: interest + identity affinity + social + quality + watch + freshness + popularity | own-content bounded; repetition penalty |
| Shorts | expected meaningful watch: `P(watch) × duration × (1+completion)` | retention beats views; tighter repetition; per-author windows |
| Search | lexical relevance DOMINANT | relevance is schema-forced ≥1.0 while personalisation caps at 0.5, AND applied as a multiplicative gate; URL deep-links (`/p/ /s/ /pp/ /op/`) resolve upstream, never through ranking |

Canonical Esporta URLs are resolved by the SAME `EsportaDeepLinkParser` the
platform's deep links use, before search ever runs — unchanged by this phase.

## Pagination

Ranked ordering has no stable sort column, so the cursor carries the SLATE: the
committed ordered ids plus offset, HMAC-signed (viewer+surface bound, 30-min TTL,
300-id cap). Page 2 is a slice of the ordering page 1 committed to — stable by
construction. A rejected/expired cursor transparently builds a fresh slate.

Legacy `before=created_at` continues to work and is the fallback path whenever
ranking is disabled or cannot produce a slate. `data` stays the bare post array;
ranking metadata rides in `meta` (ranked, cursor, algorithmVersion,
configVersionId) — no client breakage.

## Configuration (§21)

`src/recommendation/config/recommendation-config.schema.ts` is THE contract:
every tunable (weights, freshness half-lives, diversity windows, exploration
ratios, candidate limits, signal weights, decay, cold-start, safety bounds) is
declared there with `.min/.max` bounds. Validation is a security control — a
slider cannot set a weight to 99, disable diversity, or push exploration to 100%.

- Stored as immutable snapshots in `reco_algorithm_versions` (one active,
  enforced by a partial unique index). Rollback = activate an old row.
- Every mutation audited in `reco_config_audit`.
- Bounds enforced at THREE levels: zod schema, DB CHECK constraints (for
  interventions), and the ranker's clamp on composed multipliers.
- A stored version is re-validated on read; invalid → built-in defaults
  (derived from the schema, so always valid) with label `built-in-defaults`.
- `search.weights`: relevance min 1.0 / personalisation max 0.5 is **encoded in
  the bounds**, so search cannot be turned into a recommendation feed.

## Manual interventions (§25)

`reco_interventions`: bounded (boost ≤3×, suppress ≥0.25×), scoped (post or
identity, optional surface), EXPIRING (expires_at NOT NULL), auditable,
revocable. Multipliers multiply the organic score — organic is preserved in the
explanation, so revoking restores the original ranking exactly. Suppression can
only demote; it can never hide content, because visibility is an eligibility
decision computed from the product's tables, not a ranking knob.

## Admin surface (Phase 2 foundation — NO UI built)

`/api/v1/admin/recommendations/*` behind AdminGuard + in-database capability
checks (`recommendations.view|manage|debug`, declared in
`admin_capability_ids()`):

- `GET overview` — active config + feature freshness
- `GET config/history`, `GET config/:id`, `GET audit`
- `POST config/validate` — dry-run validation, all issues at once
- `POST config` → draft (validated, parsed-with-defaults, hashed)
- `POST config/:id/activate` (`rollback: true` for rollback)
- `GET features/freshness`
- `GET debug/user/:id` — viewer profile, topics, top identities, exposures
- `GET debug/content/:id` — post features + explicit eligibility verdict
- `GET debug/ranking/:viewer/:surface` — the REAL pipeline with score
  breakdowns per component
- `POST|GET interventions`, `POST interventions/:id/revoke`
- `POST rebuild` — operator-triggered feature rebuild

No generic "set score" endpoint exists anywhere.

## Feature freshness & scheduling (§38–39)

`reco_rebuild_all` is the single nightly entrypoint (order is load-bearing:
content → identity → user). Scheduled as
`GET /api/v1/webhooks/internal/recommendations-rebuild` behind
`DispatchSecretGuard` — add a cron-job.org entry at **00:45 UTC daily** (after
the 00:15 analytics aggregate, whose rollups the rebuild reads). Idempotent:
recompute-and-replace; a missed night self-heals. Signal weights and decay come
from the ACTIVE config, so retuning the interest model needs no deploy.

## Observability (§30)

Sampled structured logs (`Recommendation` context): surface, version,
candidate/eligible/result counts, cold-start, duration, fallback reason, viewer
hash (not id). No tokens, no feature vectors, no affinity lists in logs.

## Testing

`src/recommendation/**/*.spec.ts` — 91 tests: config bounds/defaults/rollback
round-trip, Wilson/freshness/exploration math, signed affinity, expected-watch,
cursor tamper-resistance, diversity windowing, per-surface ranker objectives,
self-content policy, interventions clamp, exploration determinism/rotation.
Full backend: 214/214. Flutter: `flutter analyze` clean, 242 pass (3
pre-existing `esports_card_test` failures are documented latent product defects,
unrelated).

Live-DB probes verified: idempotent rebuilds (byte-identical), §45 self-affinity
absence, Wilson overflow clamp, candidate sources for a no-follow viewer,
exclusion lists, private/deleted/blocked non-recommendation (transactional
probes, rolled back), full config lifecycle over HTTP (draft → activate → live
in feed meta → rollback → invalid rejected → audit rows), pagination without
repeats, tampered-cursor fallback, admin capability enforcement (non-admin 403),
latency p90 ≈ 1.8s over a mobile connection from this device.

## Identity search ranking (finalization, 2026-09-06)

Profile and team search now run through the same centralized framework:

- `reco_identity_ranking_inputs(viewer, ids[])` — ONE service-role round trip
  for viewer, per-identity affinity, entity features (quality/popularity/
  activity/confidence, from `reco_identity_features`) and live interventions,
  for exactly the lexical result set (≤ 50). Additive; no new table or index.
- `IdentitySearchRanker` (`core/identity-search-ranker.ts`) — ONE class ranks
  BOTH personal and team entities (a team is an identity with kind='team'):
  the same `search.weights` config as post search, the same relevance GATE
  (score × lexical relevance, so an exact match can never be buried by
  popularity or affinity), the same intervention clamp. Identity affinity and
  entity quality/activity/popularity/freshness reorder only WITHIN a
  relevance tier, bounded at 0.5 by the schema.
- `RecommendationService.rankIdentitySearch()` — not a slate (search is
  query-shaped, no pagination session to freeze); returns the re-ordered ids
  + explanations + `restrictedDropped`.
- `SearchService.profiles/teams` now carry the lexical SCORE (previously
  discarded) into the ranker and re-order the HYDRATED rows by ranked order —
  RLS-filtered identities drop rather than shift positions, the same
  fail-closed pattern as post search. Filters, browse mode and the
  `.not('id','in',blocked)` hydration filter are unchanged. On any failure
  the lexical order is served, which is the pre-ranking behaviour.
- Restricted identities (status='active' + `restricted_until` set) are
  dropped by the ranker — the only layer that can, since neither the status
  filter nor RLS excludes them.
- Admin debugger: `GET /admin/recommendations/debug/identity-search/:viewerId?kind&q`
  returns lexical matches, ranked order, per-component breakdowns and the
  restricted drop count.

**Engine bug found and fixed during finalization:** the affinity mapping was
not monotonic through zero — `signedAffinityToScore(-0.8)` (→0.05) ranked
ABOVE absent affinity (0), so a disliked author/identity sat between a
stranger and a friend instead of below a stranger. Fixed by re-centring the
component on the neutral point (`AFFINITY_NEUTRAL`) in all three rankers, and
by widening `weightedScore`'s component clamp to [-1,1] (the [0,1] clamp was
flattening the demotion back to zero). Pinned by monotonicity tests in both
the content-ranker and identity-search suites: negative < absent < positive.

## Known limitations (Phase 1)

- The exposure ring buffer is per (viewer, surface, post); a viewer who scrolls
  >300 items gets a fresh slate built from a 72h-exclusion of prior pages.
- `reco_user_identity_affinity` reads the raw ledger for (viewer,target) pairs —
  bounded by the 90-day lookback index, but it is the one place the ledger is
  scanned directly (the rollups aggregate pairs away by design).
- Non-superadmin levels do not hold `recommendations.*` capabilities yet — a
  deliberate Phase 2 roles-matrix decision, made from the console.
- Feature tables hold small live data (12 posts); the pool caps and indexes are
  sized for growth but untested at scale.
- Identity search re-orders the lexical result set only; the lexical layer
  (`search_identity_ids`) remains the sole source of WHO matches, and the
  ranked path adds no candidate generation of its own.

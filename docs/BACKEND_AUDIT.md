# Esporta Backend — Existing System Audit & Migration Map

> Mandated by `plan.md` §3 (Schema audit) and §24–25 (Edge Function migration plan).
> This document is the source of truth for **what already exists** and **how the
> new NestJS backend maps onto it**. It is written BEFORE any feature code so we
> migrate behaviour safely instead of rebuilding it.
>
> Audit date: 2026-08-25. Supabase project ref: `gaorqbmwvjlealpxvswt`.

---

## 0. Golden rules (from plan.md + repo reality)

1. **Do NOT rebuild the database.** 52 tables, ~180 RPCs, ~185 migrations already
   exist and are authored *only* via Supabase MCP `apply_migration` against the
   live DB. There is **no `supabase/migrations/` directory** — the live DB is the
   schema source of truth. The new backend sits *on top of* this; it does not
   redesign schema/RLS/Auth unless the plan explicitly requires it.
2. **Least privilege by default.** User-scoped requests use a Supabase client that
   carries the caller's JWT so RLS + `can_act_as()` still enforce. The
   service-role key is used only for genuinely actor-less server work (push
   dispatch, media-cleanup retry, signed-out account recovery).
3. **No immediate cutover.** Edge Functions stay live. The backend is built, then
   shadow/controlled, then traffic switches, then (only then) functions are
   deprecated. (plan §25)
4. **Flutter is untouched** in this workstream. We only *read* it to learn the
   request contracts the backend must honour during migration (Phase 10).

---

## 1. Runtime environment (this machine: Termux / Android / arm64)

| Tool | State |
|------|-------|
| Node | v26.4.0 ✅ |
| npm | 12.0.2 ✅ |
| pnpm | ❌ not installed — use **npm** |
| npx | ✅ |
| arch | aarch64 (arm64) |
| git | ❌ **Esporta/ is not a git repo** — no VCS safety net; changes are non-reversible via git. Be careful and additive. |

Implications: prefer npm scripts; expect some native/optional deps to be slow or
unavailable under Termux; verification is via `tsc`/`nest build`, not runtime.

---

## 2. Existing Supabase inventory

### 2.1 Tables (52, all RLS-enabled)
Identity/profile: `identities`, `profiles`, `teams`, `team_members`,
`team_categories`, `team_games`, `team_achievements`, `player_achievements`,
`user_games`, `user_settings`.
Lookups: `roles`, `games`, `game_roles`, `game_ranks`, `post_types`,
`reaction_types`, `notification_types`, `report_reasons`.
Social graph & content: `follows`, `posts`, `comments`, `reactions`,
`saved_posts`, `post_hashtags`, `mentions`, `media`, `media_cleanup_queue`.
Recruitment: `recruitments`, `applications`, `tryouts`, `application_messages`.
Notifications/push: `notifications`, `notification_deliveries`, `push_devices`.
Moderation/admin: `blocks`, `reports`, `app_admins`, `admin_audit_log`,
`admin_role_capabilities`, `premium_grants`, `verification_requests`,
`verification_request_events`.
Support: `faqs`, `support_tickets`, `support_ticket_messages`.
Security (account-level): `security_settings`, `recovery_email_otps`,
`account_sessions`, `login_approval_requests`, `security_activity`,
`account_recovery_otps`, `login_email_codes`.

### 2.2 Extensions installed (relevant)
`pgcrypto`, `citext`, `pg_net` (async HTTP — drives push/email webhooks from DB),
`pg_cron` (push safety-net + reminders), `pgmq`, `pg_trgm` + `fuzzystrmatch`
(typo-tolerant search), `uuid-ossp`, `supabase_vault`, `pgjwt`,
`pg_stat_statements`. (Search is trigram/edit-distance in Postgres — plan §27.)

### 2.3 RPC surface (~180 SECURITY DEFINER functions)
Grouped by domain — these are the **business API the backend must call**, not
re-implement:
- **Identity/profile:** `profile_json`, `save_profile`, `save_team_profile`,
  `save_team_achievements`, `create_team`, `delete_team`, `leave_team`,
  `can_act_as`, `is_team_owner/admin/member`, `set_team_admin` (owner-only).
- **Posts/engagement:** `attach_media_to_post`, `purge_post`,
  `post_reactions_breakdown`, `comment_reactions_breakdown`,
  `post_media_window_open`, `extract_hashtags`, `extract_mentioned_ids`,
  `mentionable_ids`.
- **Recruitment:** `accept_application`, `notify_tryout`, `notify_on_*` triggers,
  application/tryout guard triggers.
- **Notifications/push:** `notify`, `mark_notifications_read`,
  `register_push_device`, `deactivate_push_device`, `deactivate_push_tokens`,
  `claim_push_deliveries`, `complete_push_delivery`, `push_dispatch_wake`,
  `notification_push_channel`, `notification_pref_enabled`,
  `notification_push_payload`, `verify_dispatch_secret`.
- **Media lifecycle:** `claim_media_cleanup`, `resolve_media_cleanup`,
  `fail_media_cleanup`.
- **Security:** `security_*` (reauth, two-step, recovery email, devices,
  login approval, activity feed), `account_recovery_start/verify`,
  `assert_recent_reauth`, `security_begin_login`.
- **Admin (core-admin):** `admin_*` (dashboard, users, posts, comments, reports,
  verification, premium, moderation, announcements, audit, support, faq,
  reference data) — all capability-gated via `admin_has`/`admin_require`.
- **Blocks:** `assert_not_blocked`, `blocks_between`, `blocked_identity_ids`.

### 2.4 Migrations
~185 migrations from `20260807050428_create_profiles` →
`20260824173414_security_overview_two_step_master`. Live-DB only. The backend
must NOT introduce a competing migration mechanism; any *required* schema change
(none expected for phases 1–4) goes through MCP `apply_migration`.

---

## 3. Auth, identity & authorization model

- **Auth = Supabase Auth (gotrue).** Flutter logs in and holds the access token.
  The backend NEVER issues sessions; it **verifies** the `Authorization: Bearer
  <jwt>` on each request and resolves `user_id` from it — never trusting a
  client-supplied user id. (plan §6)
- **Identity model:** one `identities` table (`kind = personal | team`). A
  **personal** identity's `id == auth.uid()`. `profiles.id` / `teams.id` are
  FK → `identities.id`.
- **Active profile:** requests carry `X-Active-Profile-Id`. The backend must not
  trust it blindly — it validates via `can_act_as(target_identity, actor)` =
  self OR active team member with role in (`owner`,`admin`). (plan §7)
- **3-layer authorization** (plan §8): (1) valid JWT → (2) profile ownership/
  access via `can_act_as` → (3) action permission (e.g. owner-only + recent
  reauth via `assert_recent_reauth`). RLS then re-enforces at the DB.
- **DB access strategy** (plan §9): two clients —
  - *caller-scoped* (anon key + caller JWT in header) → RLS applies. **Default.**
  - *service-role* → only actor-less privileged jobs. Never the default.

---

## 4. Edge Functions — behaviour & migration targets

Local source mirror: `supabase/functions/` (matches deployed versions).
Shared media logic: `supabase/functions/_shared/media.ts`.

| Function | verify_jwt | Auth gate | Core behaviour | Migrates to |
|----------|-----------|-----------|----------------|-------------|
| `media-upload` v15 | ✅ | `can_act_as` | multipart file → provider chain → insert `media` row (caller client) | `MediaService` (§11–12) |
| `media-delete` v14 | ✅ | `can_act_as` (row-owner) | lookup `media` → provider `.remove` → delete row | `MediaService` |
| `media-replace` v15 | ✅ | `can_act_as` | store new → update row → remove old | `MediaService` |
| `media-cleanup` v12 | ✅ | service-role | `claim_media_cleanup` → provider `.remove` → `resolve/fail_media_cleanup` | cleanup workflow |
| `post-delete` v12 | ✅ | `purge_post` (RPC does authz) | `purge_post` → provider removes → resolve/fail cleanup | `PostService`+`MediaService` |
| `push-dispatch` v9 | ❌ | `x-dispatch-secret` → `verify_dispatch_secret` | FCM v1 OAuth → `claim_push_deliveries` → `messages:send` → `complete_push_delivery` → `deactivate_push_tokens` | `NotificationService`+FCM provider (§22) |
| `security-email` v8 | ❌ | — | **DECOMMISSIONED 2026-09-04** — returns 410. Custom security mail is now sent by `EmailService` from `public.email_outbox`; the DB no longer pg_nets out. Delete in the dashboard. | `SecurityService`+`EmailService`+`EmailOutboxService` |
| `account-recovery` v6 | ❌ | — | **DECOMMISSIONED 2026-09-04** — returns 410. Superseded by `POST /api/v1/auth/account-recovery`. Delete in the dashboard. | `AccountRecoveryService` |

### 4.1 Media provider routing (CURRENT — `_shared/media.ts`)
- **Identity images** (avatar/cover/team logo/banner) → **Supabase Storage**
  buckets `avatars`/`covers`, uploaded with the caller token so bucket RLS
  enforces ownership. `upsert: true`.
- **Post images** → **Cloudflare R2** (S3 API via `aws4fetch`), Supabase fallback.
- **Post/Short videos** → **Cloudinary** (returns width/height/duration/poster),
  Supabase fallback.
- `objectKey`: identity images `= {identityId}/{slot}{ext}`; post files
  `= {identityId}/{ts}_{rand}{ext}`. First path segment = owning identity id
  (Supabase Storage RLS checks it via `can_act_as`).
- `media` row columns: `owner_user_id, owner_identity_id, entity_type
  (profile|team|post), entity_id, post_id, slot (avatar|cover|attachment),
  media_type (image|video), provider (supabase|r2|cloudinary), storage_path,
  public_url, thumbnail_url, mime_type, file_size_bytes, width, height,
  duration_seconds, upload_status, processing_status`.
- Size caps: image 10 MB, video 100 MB.

### 4.2 Flutter client contracts (must stay compatible during migration)
- `media-upload`: multipart `file` + fields `identityId, entityType, slot,
  mediaType, entityId?`.
- `media-replace`: multipart `file` + `{mediaId}`.
- `media-delete`: `{mediaId}`.
- `post-delete`: `{postId}`.
- `account-recovery`: `{action:'start'|'verify', email, code?}`.
- Achievement proofs: Flutter uploads **directly** to a private Supabase bucket
  (`media_service.dart` `storage.from(proofBucket)`) — not via an edge function.
- Security/push/notifications: direct **RPC** calls (`security_*`,
  `register_push_device`, `mark_notifications_read`, …).

---

## 5. ⚠️ Divergences: plan.md vs. what exists — DECIDED 2026-08-25

> User decisions (2026-08-25): **(1) Video → build Cloudflare Stream, keep
> Cloudinary readable. (2) Images → ALL images to R2 (literal §11), including
> avatars/covers.** These resolve the two open forks below.

| Topic | plan.md wants | Exists today | Resolution (DECIDED) |
|-------|---------------|--------------|------------|
| **Video** | Cloudflare **Stream** (direct-creator upload + webhook + `provider_uid`, status uploading→processing→ready→failed) | **Cloudinary** signed upload | ✅ Build the **Stream** path per plan §13–16 for all NEW video/Shorts. Existing Cloudinary rows (`provider='cloudinary'`) keep playing until re-encoded/retired. Add `provider='stream'` + `provider_uid`/`status` to `media` via an additive MCP migration at **Phase 6**. |
| **Images** | "all images → R2" | identity images on **Supabase Storage**, post images on **R2** | ✅ **All NEW image uploads → R2** (avatars, covers, post images) per §11. Existing avatars/covers on Supabase Storage keep serving via their stored `public_url` until migrated. New identity-image upload path (Phase 5) writes to R2 and updates `identities.avatar_url`/`cover_url` (+ `media` row). Needs a serving/migration story for legacy Supabase-Storage identity images. |
| **R2 env names** | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_PUBLIC_BASE_URL` | `CLOUDFLARE_R2_ACCOUNT_ID`, …, `CLOUDFLARE_R2_PUBLIC_URL` | New backend uses plan names (`R2_*`); the config layer maps/accepts both so ops can reuse existing secrets during shadow. |
| **Upload transport** | presigned/direct-creator upload (client → provider directly; backend never proxies bytes) | media-upload **proxies bytes** through the edge function | Adopt the plan's presigned model for the new R2/Stream paths (better for Vercel's short-lived functions, §41). Keep a proxy-compatible endpoint only if needed for parity during shadow. |
| **Push secret** | — | dispatch secret stored in DB, verified by `verify_dispatch_secret` (not an env var) | Backend calls the same RPC contracts; the DB→backend nudge uses `INTERNAL_WEBHOOK_SECRET` (plan §35) or reuses the dispatch-secret RPC. |

---

## 6. Environment variable reconciliation

Plan master list (§10, tail): `NODE_ENV PORT API_BASE_URL APP_ORIGIN
SUPABASE_URL SUPABASE_ANON_KEY SUPABASE_SERVICE_ROLE_KEY R2_ACCOUNT_ID
R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET R2_PUBLIC_BASE_URL
CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_STREAM_API_TOKEN CLOUDFLARE_STREAM_WEBHOOK_SECRET
FIREBASE_PROJECT_ID FIREBASE_CLIENT_EMAIL FIREBASE_PRIVATE_KEY SMTP_HOST SMTP_PORT
SMTP_USERNAME SMTP_PASSWORD SMTP_FROM_EMAIL INTERNAL_WEBHOOK_SECRET
ENCRYPTION_KEY`.

Each secret is read only by the module that needs it (config validation groups
them). `.env.example` carries names only, never values. Existing edge-function
secret names (`CLOUDFLARE_R2_*`, `CLOUDINARY_*`) remain valid on the Supabase side
until those functions are retired.

---

## 7. Feature → Table(s) → RPC(s) → Edge Fn → Backend module

| Feature | Table(s) | RPC(s) | Edge Fn | Backend module | Phase |
|---------|----------|--------|---------|----------------|-------|
| Auth/JWT verify | `auth.users`, `identities` | — (verify JWT) | — | `auth/` | 2 |
| Profiles | `identities`,`profiles`,`user_games`,`user_settings` | `profile_json`,`save_profile` | — | `profiles/` | 3 |
| Teams | `teams`,`team_members`,`team_*` | `create_team`,`save_team_profile`,`set_team_admin`,`delete_team`,`leave_team` | — | `teams/` | 3 |
| Posts | `posts`,`post_types`,`post_hashtags`,`mentions`,`media` | `attach_media_to_post`,`purge_post`,`post_media_window_open` | `post-delete` | `posts/` | 3/5 |
| Comments | `comments` | (triggers) `notify_on_comment` | — | `comments/` | 3 |
| Reactions | `reactions`,`reaction_types` | `post_reactions_breakdown`,`comment_reactions_breakdown` | — | `reactions/` | 3 |
| Follows | `follows` | (triggers) `notify_on_follow`,`drop_follows_on_block` | — | `follows/` | 3 |
| Recruitment | `recruitments` | recruitment guards, `admin_moderate_recruitment` | — | `recruitment/` | 4 |
| Applications | `applications`,`application_messages` | `accept_application`, transition guards | — | `applications/` | 4 |
| Tryouts | `tryouts` | `notify_tryout`, tryout guards | — | `tryouts/` | 4 |
| Notifications | `notifications`,`notification_types` | `notify`,`mark_notifications_read` | — | `notifications/` | 4 |
| Push | `push_devices`,`notification_deliveries` | `register_push_device`,`claim_push_deliveries`,`complete_push_delivery`,`deactivate_push_tokens`,`verify_dispatch_secret` | `push-dispatch` | `push/` | 7 |
| Security | `security_settings`,`account_sessions`,`login_approval_requests`,`recovery_email_otps`,`security_activity`,`account_recovery_otps`,`login_email_codes`,**`email_outbox`** | `security_*`,`account_recovery_*`,`assert_recent_reauth`,**`email_outbox_claim`/`email_outbox_complete`** | none (both edge fns decommissioned 2026-09-04) | `security/`+`email/` | 4/7 |
| Media (images) | `media`,`media_cleanup_queue` | `attach_media_to_post`,`claim/resolve/fail_media_cleanup` | `media-upload/delete/replace/cleanup` | `media/`+`storage/` (R2 provider) | 5 |
| Media (video) | `media` | (new: `provider_uid`,status) | (new Stream webhook) | `media/` (Stream provider)+`webhooks/stream` | 6 |
| Support | `support_tickets`,`support_ticket_messages`,`faqs` | `reply_support_ticket`,`admin_*` | — | `support/` | 4/8 |
| Search | (trigram on identities/posts) | `search_identity_ids`,`search_post_ids` | — | `search/` | 3 |
| Admin | admin/audit/verification/premium tables | `admin_*` (capability-gated) | — | `admin/` | 8 |
| Analytics | (new `analytics_events`) | — | — | `analytics/` | 9 |
| Blocks | `blocks` | `assert_not_blocked`,`blocked_identity_ids` | — | `common/` guard | 3 |

---

## 8. Build order (locked, plan §42)
P1 foundation → P2 auth/profile-context → P3 profiles/teams/posts/comments/
reactions/follows → P4 recruitment/applications/tryouts/notifications/security →
P5 R2 images → P6 Stream video+webhook → P7 FCM+Gmail → P8 admin → P9 analytics
ingestion → P10 Flutter migration.

Response envelope (§30): `{success, data, error:{code,message}, meta}`.
Versioning (§31): all routes under `/api/v1`. CORS (§36): allow-list only.
Vercel (§41): no long-running processes; media processing is Stream's job.

---

## 9. The admin surface and the core-admin contract

`core-admin` reaches the platform **only** through this API's typed admin routes.
There is deliberately **no** generic `POST /admin/rpc` passthrough: arbitrary
database RPC execution behind one endpoint would bypass per-route DTO validation
and make the reachable surface unauditable. Every operation the console can
perform is a named controller action behind `AdminGuard`, and each underlying
`admin_*` RPC still enforces its own capability with `admin_require`.

**59 admin routes** across five controllers:

| Controller | Surface |
|---|---|
| `admin-users.controller.ts` | `me`, users/identities, verification queue, admins & roles, capabilities |
| `admin-content.controller.ts` | posts, comments, recruitments, applications, tryouts, reports |
| `admin-support.controller.ts` | support tickets, FAQs, reference data |
| `admin-meta.controller.ts` | dashboard, timeseries, settings, storage/push overviews, touch, audit, outbound notifications |
| `analytics/admin-analytics.controller.ts` | `/admin/analytics/*` (Analytics Part 3) |

Routes added while making core-admin compatible — all bind service methods that
already existed but had no controller:

```
GET  /admin/me                        GET  /admin/audit
GET  /admin/dashboard                 GET  /admin/notifications
GET  /admin/timeseries?days=          POST /admin/notifications/send
GET  /admin/settings                  POST /admin/notifications/announce
GET  /admin/storage-overview          POST /admin/touch
GET  /admin/push-overview
```

`POST /admin/verification/:id/decide` takes `{decision, note?, cooldown_days?}`.
`decision` is a tri-state (`approve`|`reject`|`not_eligible`), not a boolean:
`admin_decide_verification_request` is overloaded in Postgres, and the boolean
overload cannot express `not_eligible` (a 90-day reapply cooldown rather than 7)
or a custom cooldown at all.

### Error contract: the SQLSTATE and hint are preserved

`mapPostgrestError` (in `supabase/supabase.service.ts`) attaches the Postgres
SQLSTATE, `hint` and raw message to `error.details`. This is load-bearing, not
decoration: the `admin_*` RPCs raise semantic hints only they define —
`self_escalation`, `superadmin_locked`, `capability_required`,
`no_self_escalation`, `rate_limited` — and a console needs them to phrase the
refusal correctly. Collapsing every `42501` into one generic 403 made those
distinctions unrecoverable by any client.

The client-facing `message` stays generic for `42501`/`P0002`, so a normal app
path cannot leak `permission denied for table x`; the raw sentence travels in
`details.message` for consumers that want it. `P0002` (no_data_found) maps to
**404**, so a detail page renders "not found" rather than an error page.
Covered by `src/supabase/postgrest-error.spec.ts`.

### Keeping the two sides in sync

`core-admin/src/lib/admin-routes.ts` is the single allowlist mapping each
`admin_*` operation to its REST route. After changing any admin controller,
regenerate the route snapshot and re-run the check:

```bash
cd core-admin && npm run verify:routes
```

It fails loudly on a renamed route, a wrong verb or a typo — none of which
TypeScript can catch, because the paths are built as strings.

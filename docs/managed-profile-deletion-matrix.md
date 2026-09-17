## Deletion matrix — managed-profile (team) permanent deletion

Ground truth (verified 2026-09-17, live DB + code):
- `media_cleanup_queue`: PK id; NOT NULL provider/storage_path/entity_type/slot;
  nullable media_id/owner_identity_id/post_id; attempts int NOT NULL default 0;
  last_error, last_attempt_at, resolved_at, created_at. NO needs_attention, NO
  next_attempt_at, NO provider_uid. Unique partial index on (provider, storage_path)
  WHERE resolved_at IS NULL. RLS: no policies, service-role only.
- Provider enum `media_provider` = supabase,r2,cloudinary,stream. `keyFromPath`
  strips the first path segment (bucket). R2 storage_path = `esporta/<key>`.
- Team FKs: teams.owner_id → identities RESTRICT; teams.id → identities CASCADE;
  teams.category_id → team_categories RESTRICT. Almost all children of
  identities are ON DELETE CASCADE (verified FK map incl. posts, comments,
  reactions, comment_reactions, saved_posts, follows, media, notifications,
  applications, recruitments, team_members, team_games, team_achievements,
  profiles, role_details, chat messages, push_devices, one_time_tokens, feeds,
  reco/analytics identity tables, team_inboxes). Verified: NO audit rows have
  admin_id = a team identity (admin_audit_log.admin_id NOT NULL + ON DELETE SET
  NULL cannot block team destruction; 11 audit rows target teams via unfixed
  target_id and are retained). platform_settings.updated_by, premium_grants.
  granted_by, verification_requests.reviewed_by are nullable SET NULL.
- Cron is pg_cron IN-DB (jobs: push-dispatch-drain `* * * * *`,
  security-approvals-expire `* * * * *`). External cron-job.org GETs are a
  separate pattern. NO vercel.json anywhere. push_dispatch_wake: SECURITY DEFINER,
  search_path="", private.app_secrets (url+secret+throttle), pg_net POST,
  warn-and-continue. One shared dispatch secret (verify_dispatch_secret reads
  push_dispatch_secret for ALL internal endpoints). dispatch-secret.guard.ts
  verifies `x-dispatch-secret` against public.verify_dispatch_secret.
- Internal controller: POST/GET /webhooks/internal/media-cleanup → drain().

| # | Artifact | Action | Reason |
|---|----------|--------|--------|
| 1 | identity (team) row | Hard-DELETE via new `finalize_profile_deletion`, only when status='deleted' AND purge_requested_at set AND queue clear | Permanent removal; CASCADE removes team+content; RESTRICT owner FK nulled first |
| 2 | teams row + team_games/team_achievements/team_members/team_inboxes | CASCADE with identity | Child data of the destroyed profile |
| 3 | posts/comments/reactions/saves/media of the identity | Soft-delete now (delete_team unchanged), hard-delete at finalize via CASCADE | Provider objects must be purged before references vanish |
| 4 | media rows | CASCADE with identity, but only after queue clear | Queue references are destroyed at finalize |
| 5 | Supabase Storage objects (avatars/covers/posts buckets) | Drainer removal, DB keys only, error-tolerant + verified-gone re-check | Orphans exist today for deleted identities; bucket-derived path; 404=success |
| 6 | Cloudflare R2 objects | Drainer via r2.delete(keyFromPath(storage_path)) | keyFromPath strips bucket; delete idempotent 404=success |
| 7 | Cloudflare Stream videos | Drainer via provider_uid re-read from media; NULL uid = needs_attention (never resolved) | provider_uid is canonical reference |
| 8 | Cloudinary media | Needs_attention (unresolved) if provider unreachable; never resolved | Verified: 5 rows, all personal-owned; NO team-owned Cloudinary media exists (not inventable); guarded so it can't be silently dropped |
| 9 | achievement-proofs bucket | NOT routable — unknown bucket ⇒ needs_attention | Verified: 0 objects, 0 media rows, unused by code; future use must extend allow-list explicitly |
| 10 | notifications (recipient=team / actor=team / entity refs) | delete_team deletes recipient-side (unchanged); finalize deletes remaining actor/entity pointers | No broken navigation; FK CASCADE does most; entity_id has NO FK |
| 11 | admin_audit_log rows (admin_id=owner person, target=team) | RETAINED | Audit/security records preserved; no FK on target_id; verified no team-as-admin rows exist |
| 12 | follows | Deleted by delete_team (unchanged); remainder CASCADE | Access revocation preserved |
| 13 | applications/recruitments | Resolved/closed by delete_team (unchanged); rows CASCADE at finalize | Applicant-facing closure preserved |
| 14 | reco_content_features / reco_identity_features / exposure | Immediate serving exclusion (reco_candidates: p.deleted_at is null, moderation='published', a.status='active'); CASCADE removal at finalize | Immediate exclusion, no nightly-wait dependency; retention impossible after destruction |
| 15 | analytics_events / analytics_daily_* | actor SET NULL (nullable); daily aggregates RETAINED | Historical metrics, no PII URL; serving unaffected |
| 16 | media_cleanup_queue rows | Auto-managed: claim (incl. past-cap slow-retry) → attempts/last_error/needs_attention → resolved_at only on provider confirmation or verified-gone | Stale rows stuck since Sep 9 (attempts cap) must drain or become visible |
| 17 | Scheduling | Trigger wake (pg_net, throttle 3s) on queue insert + pg_cron `*/5 * * * *` safety net; drain tail calls finalize for ready identities | Fully automatic; reuses the push-dispatch wake pattern; no external scheduler dependency |
| 18 | owner seats on deleted team | teams.owner_id set NULL at finalize | RESTRICT FK otherwise blocks identity deletion |


## Requirement matrix — every listed requirement → concrete action

| Req | Required behavior | Action implemented |
|-----|-------------------|--------------------|
| R1 | Scheduler that runs cleanup automatically, without external cron, using the push-dispatch wake pattern | `media_cleanup_wake(p_force boolean)` SECURITY DEFINER search_path='' — pg_net POST to `private.app_secrets['media_cleanup_url']` with `x-dispatch-secret`, 3s throttle via `media_last_wake_at`, warn-and-continue; statement-level trigger `media_cleanup_enqueued_wake` on INSERT into `media_cleanup_queue`; pg_cron `media-cleanup-drain` every 5 min (`select public.media_cleanup_wake(true);`) as the safety net; URL derived at migration time from `push_dispatch_url` (same host, last path segment → `media-cleanup`), secret reused via `verify_dispatch_secret` |
| R2 | Retry/dead-letter: past max attempts never falsely resolved, never vanished | `claim_media_cleanup` rewritten: cap-based backoff BEFORE cap, capped slow retry (24h) AFTER; attempts increment in claim; `needs_attention` boolean (NULL = queued, true = needs operator) — exhausted rows stay claimable and visible forever |
| R3 | Provider not-found = success | All providers treat 404/missing as success; Supabase Storage removal now verified with an existence re-check (`exists()` after remove) so 'not found' is distinguished from an unknown failure |
| R4 | Never resolved without provider confirmation | Drainer resolves only after the provider call succeeds or verified-gone re-check passes; `markResolved` clears needs_attention |
| R5 | Cloudinary explicit state, never silently resolved | `CloudinaryUnreachable` now → `markNeedsAttention` (row stays open, reason recorded), NOT resolve; verified: 5 cloudinary rows exist, all owned by personal identities — **no team-owned Cloudinary media exists** (nothing invented); any future team-owned cloudinary row lands in needs_attention, visibly |
| R6 | Supabase Storage cleanup, DB-derived keys only, all used buckets | Buckets derived from each row's storage_path first segment; allow-list = exactly the 3 buckets verified in live use (avatars, covers, posts); unknown bucket ⇒ unroutable error → needs_attention (achievement-proofs excluded by evidence: 0 objects/0 media rows) |
| R7 | R2 via existing abstraction + normalization | `r2.delete(keyFromPath(storage_path))` (strips `esporta/` bucket prefix) — existing purgeProviderMedia path |
| R8 | Stream via provider_uid | uid re-read from media row; missing uid/row ⇒ needs_attention (never resolved without confirmation) |
| R9 | Orphaned objects of already-deleted profiles cleaned | Backfill: on migration, open tasks for `status='deleted'` identities are re-offered immediately (`needs_attention=false, last_attempt_at=null`) so the first drain after deploy purges the real legacy orphans (4 supabase + 6 R2 verified) |
| R10 | Automatic final cleanup step after objects are purged | `finalize_profile_deletion(p_identity_id)` SECURITY DEFINER service-role-only: refuses unless status='deleted' AND purge_requested_at NOT NULL AND no unresolved queue rows (needs_attention blocks finalization too — nothing unresolved is ever swept); deletes entity-pointer notifications, nulls teams.owner_id, DELETE identity → CASCADE destroys team/content/reco rows; audit + analytics aggregates retained by design |
| R11 | Scheduled finalization (not manual) | Drain tail calls finalize for every eligible `purge_requested_at IS NOT NULL AND status='deleted'` identity whose queue is clear; the same wake/cron that drains media finalizes profiles |
| R12 | Deletion matrix artifact | This document |
| R13 | Verify idempotent + concurrency-safe | Rolled-back probes: duplicate claim (skip locked), double finalize (no-op), revocation regression (delete_team unchanged); live verification: real drainer run against the 6 real R2 orphans + 4 supabase orphans with HTTP/GONE confirmation |
| R14 | Do not hardcode buckets from existence alone | Allow-list = avatars/covers/posts (verified via storage.objects + media rows); achievement-proofs documented as unroutable |
| R15 | Do not invent team Cloudinary ownership | Verified owner kinds of all cloudinary rows; explicit state instead |
| R16 | Permanent posts removal via provider-aware pipeline | delete_team soft-deletes posts (revocation/serving-exclusion immediate), purge_team_media enqueues attachments (existing), queue drains objects, finalize hard-deletes content — never the unsafe per-post path |
| R17 | Revocation must not regress | teams.service.ts delete path untouched; delete_team untouched; only additive wake trigger on the queue table |

## Post-implementation verification log (2026-09-17, live production DB + providers)

| Check | Method | Result |
|-------|--------|--------|
| Migration applied | `tmp-probe/apply.js` (23→24 statements) | all ok; cron job `media-cleanup-drain` `*/5 * * * *` registered and succeeding (job_run_details: succeeded) |
| Wake URL derived | `private.app_secrets` | `media_cleanup_url` = push_dispatch_url host + `/media-cleanup` (67 chars, verified present) |
| Wake trigger | live insert into queue with expired throttle | `media_last_wake_at` advanced (true); real pg_net POST fired |
| Finalize guards | single-transaction rollback probes | `purge_not_requested`, `cleanup_pending` (blocks with open task), `finalized:true` (cascade destroys identity/team/posts/media/member-notifs), `already_gone` (idempotent) — all observed live |
| Claim semantics | rollback probes | needs_attention rows excluded (0 claimed) then claimable after clearing (6 claimed); recent at-cap row excluded (0); 25h-old at-cap rows slow-retried (6 claimed, attempts 10→11) |
| Single increment | claim+fail probe | attempts=1 after one claim+fail (fail no longer double-counts); flag flips only at attempts>=10 |
| Permissions | has_function_privilege | anon/authenticated cannot execute finalize RPCs; service_role can |
| delete_team untouched | md5(prosrc) before/after | identical (a915656f…) — revocation path unchanged |
| Legacy R2 orphans | real drain via compiled service + independent S3 HEAD (`tmp-probe/r2head.js`) | 6/6 rows claimed+purged; all 6 keys 404-gone afterwards; second drain: 0 claimed (idempotent) |
| Full pipeline E2E | synthetic team profile + real R2 object (PUT 200, HEAD 200) → delete+mark → enqueue → drain | `claimed 1, purged 1, finalized 1`; identity/team/media/notification rows gone; owner identity untouched (active); object 404-gone; queue row resolved |
| Legacy backfill | mark-then-finalize exposed ordering gap → migration corrected to enqueue-before-mark; 4 missed objects (3 supabase + 1 r2) enqueued and purged | storage.objects rows 0; r2 HEAD 404; queue 0 open / 13 total |
| tsc / flutter analyze | `tsc --noEmit`, `flutter analyze` (changed files) | clean; no issues |


| 19 | reauth/ownership guards | UNCHANGED (requireOwner, assertFreshReauth, purge_team_media, delete_team) | Revocation path must not regress |

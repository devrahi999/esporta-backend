-- 4) media_cleanup_wake(p_force boolean): SECURITY DEFINER (search_path=''), pg_net POST to the
--    media-cleanup internal endpoint, reading url/secret from private.app_secrets
--    (`media_cleanup_url` set below by deriving the host from `push_dispatch_url`; the shared
--    `push_dispatch_secret` is what dispatch-secret.guard already verifies), 3s
--    throttle via `media_last_wake_at`, warn-and-continue (same shape as push_dispatch_wake).
-- 5) trigger media_cleanup_queue_wake AFTER INSERT ON media_cleanup_queue -> media_cleanup_wake(false).
-- 6) pg_cron job 'media-cleanup-drain' every 5 minutes -> select public.media_cleanup_wake(true);
--    (mirrors push-dispatch-drain; in-DB pg_cron is the established scheduling pattern here —
--    no vercel.json exists in this repo).
--
-- Finalization design (permanent destruction): delete_team (unchanged) soft-deletes
-- content + revokes access; purge_team_media (existing, called by the service) enqueues all
-- provider objects; once the drainer resolves every open task for the identity, the identity is
-- permanently destroyed (hard DELETE -> CASCADE removes team/posts/comments/media/team child
-- rows; audit rows and analytics aggregates are retained by design). destroy is guarded so it
-- never runs while any cleanup task is unresolved, and never runs twice (no-op when the
-- identity is already gone).
-- ===========================================================================

begin;

-- 1) identity marker: set by the teams service at deletion time.
alter table public.identities
  add column if not exists purge_requested_at timestamptz;

-- 2) Queue hardening: a visible dead-letter state. (The existing unique
--    partial index media_cleanup_unresolved_object_idx on
--    (provider, storage_path) WHERE resolved_at IS NULL already guarantees one
--    unresolved task per object while letting a path re-enqueue after a
--    resolved generation — keep it untouched; the enqueue RPCs' ON CONFLICT
--    arbiter depends on it.)
alter table public.media_cleanup_queue
  add column if not exists needs_attention boolean;

comment on column public.media_cleanup_queue.needs_attention is
  'NULL = queued normally; true = needs an operator (exhausted retries, unroutable path, or an unreachable provider). Unresolved rows are never falsely treated as deleted.';

-- Backfill: tasks that predate the scheduler and belong to already-deleted
-- profiles are the real orphans this task must clear — re-offer them on the
-- first drain after this migration (needs_attention cleared, no backoff).
update public.media_cleanup_queue q
   set needs_attention = null,
       last_attempt_at = null
 where q.resolved_at is null
   and exists (
     select 1 from public.identities i
      where i.id = q.owner_identity_id and i.status = 'deleted'
   );

-- 3) Claim: exponential backoff before the cap, capped slow retry after it.
--    Rows past the cap are never dropped and never marked resolved: they stay
--    claimable once a day and are flagged needs_attention so they remain
--    visible while still resolving on any later provider success.
create or replace function public.claim_media_cleanup(p_limit integer default 25)
returns setof public.media_cleanup_queue
language plpgsql
as $fn$
begin
  return query
  update public.media_cleanup_queue q
     set attempts = q.attempts + 1,
         last_attempt_at = now()
   where q.id in (
     select c.id
       from public.media_cleanup_queue c
      where c.resolved_at is null
        and coalesce(c.needs_attention, false) = false
        and (
          c.last_attempt_at is null
          or (
            c.attempts < 10
            and c.last_attempt_at < now() - (interval '2 minutes' * power(2, least(c.attempts, 6)))
          )
          or c.last_attempt_at < now() - interval '24 hours'
        )
      order by c.created_at
      limit greatest(coalesce(p_limit, 25), 1)
      for update skip locked
   )
  returning q.*;
end;
$fn$;

create or replace function public.fail_media_cleanup(p_id uuid, p_error text)
returns void
language plpgsql
as $fn$
begin
  -- attempts is incremented by claim_media_cleanup (the attempt happened when
  -- the row was claimed); this only records the outcome and flips the
  -- dead-letter flag once the attempt count reaches the cap.
  update public.media_cleanup_queue q
     set last_attempt_at = now(),
         last_error = left(coalesce(p_error, 'unknown error'), 500),
         needs_attention = case
           when q.attempts >= 10 then true
           else coalesce(q.needs_attention, false)
         end
   where q.id = p_id
     and q.resolved_at is null
     and (
       (select auth.uid()) is null
       or q.owner_identity_id is null
       or public.can_act_as(q.owner_identity_id)
     );
end;
$fn$;

create or replace function public.resolve_media_cleanup(p_ids uuid[])
returns integer
language plpgsql
as $fn$
declare
  v_count integer;
begin
  if p_ids is null or array_length(p_ids, 1) is null then
    return 0;
  end if;

  update public.media_cleanup_queue q
     set resolved_at = now(),
         last_attempt_at = now(),
         last_error = null,
         needs_attention = null
   where q.id = any (p_ids)
     and q.resolved_at is null
     and (
       (select auth.uid()) is null
       or q.owner_identity_id is null
       or public.can_act_as(q.owner_identity_id)
     );

  get diagnostics v_count = row_count;
  return v_count;
end;
$fn$;

-- 4) Wake: mirror of push_dispatch_wake — pg_net POST to the media-cleanup
--    internal endpoint, secret + URL from private.app_secrets, 3s throttle,
--    warn-and-continue (a lost nudge is recovered by the cron job below).
create or replace function public.media_cleanup_wake(p_force boolean default false)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  secret text;
  last   timestamptz;
  base   text;
begin
  if not p_force then
    select value::timestamptz into last
      from private.app_secrets where name = 'media_last_wake_at';
    if last is not null and last > now() - interval '3 seconds' then
      return;
    end if;
  end if;

  insert into private.app_secrets (name, value)
  values ('media_last_wake_at', now()::text)
  on conflict (name) do update set value = excluded.value;

  select value into secret from private.app_secrets where name = 'push_dispatch_secret';
  if secret is null then return; end if;

  select nullif(btrim(coalesce(value, '')), '') into base
    from private.app_secrets where name = 'media_cleanup_url';
  if base is null then
    raise warning 'media_cleanup_wake: media_cleanup_url is not set';
    return;
  end if;

  perform net.http_post(
    url := base,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-dispatch-secret', secret),
    body := jsonb_build_object('source', case when p_force then 'cron' else 'trigger' end));
exception when others then
  raise warning 'media_cleanup_wake failed: %', sqlerrm;
end;
$fn$;

create or replace function public.media_cleanup_enqueued_wake()
returns trigger
language plpgsql
as $fn$
begin
  perform public.media_cleanup_wake(false);
  return null;
end;
$fn$;

drop trigger if exists media_cleanup_queue_wake on public.media_cleanup_queue;
create trigger media_cleanup_queue_wake
after insert on public.media_cleanup_queue
for each statement execute function public.media_cleanup_enqueued_wake();

-- Safety net: the trigger covers the hot path; cron guarantees progress even
-- when a wake POST is lost. Same pattern as push-dispatch-drain.
do $do$
begin
  if exists (select 1 from cron.job where jobname = 'media-cleanup-drain') then
    perform cron.unschedule('media-cleanup-drain');
  end if;
  perform cron.schedule(
    'media-cleanup-drain',
    '*/5 * * * *',
    $cmd$ select public.media_cleanup_wake(true); $cmd$
  );
end;
$do$;

-- The drainer URL (same host as the push dispatcher, last path segment
-- swapped). Storing it in app_secrets keeps the host config-driven, exactly
-- like push_dispatch_url; the secret it posts with is push_dispatch_secret,
-- which dispatch-secret.guard already verifies for /webhooks/internal/*.
insert into private.app_secrets (name, value)
select 'media_cleanup_url', regexp_replace(value, '[^/]+$', 'media-cleanup')
  from private.app_secrets
 where name = 'push_dispatch_url'
on conflict (name) do update set value = excluded.value;

-- 5) Permanent destruction, once every provider object is verifiably gone.
--    Guarded: callable only by the service role (the drainer's tail) — anon and
--    authenticated are revoked below (same exposure model as
--    push_dispatch_wake, whose cron sessions carry no JWT). The identity must
--    be status='deleted' with purge_requested_at set, and NO cleanup task may
--    remain unresolved (needs_attention blocks too — an unresolved task is
--    never swept). Idempotent: a gone identity is a silent no-op.
create or replace function public.finalize_profile_deletion(p_identity_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_status text;
begin
  select i.status into v_status
    from public.identities i
   where i.id = p_identity_id;

  if v_status is null then
    return jsonb_build_object('identity_id', p_identity_id, 'finalized', false, 'reason', 'already_gone');
  end if;

  if v_status <> 'deleted' then
    return jsonb_build_object('identity_id', p_identity_id, 'finalized', false, 'reason', 'not_deleted');
  end if;

  if not exists (
    select 1 from public.identities i
     where i.id = p_identity_id and i.purge_requested_at is not null
  ) then
    return jsonb_build_object('identity_id', p_identity_id, 'finalized', false, 'reason', 'purge_not_requested');
  end if;

  if exists (
    select 1 from public.media_cleanup_queue q
     where q.owner_identity_id = p_identity_id
       and q.resolved_at is null
  ) then
    return jsonb_build_object('identity_id', p_identity_id, 'finalized', false, 'reason', 'cleanup_pending');
  end if;

  -- Notifications that merely point at the destroyed profile (entity_id has no
  -- FK): actor_id=team and recipient_id=team rows already CASCADE with the
  -- identity. entity_type is a uuid-valued enum here; cast for the lookup.
  delete from public.notifications n
   where n.entity_id = p_identity_id
      or (n.entity_type::text = 'team_member' and n.entity_id in (
            select m.id from public.team_members m where m.team_id = p_identity_id));

  -- Seat vacating must precede the identity delete (owner_id RESTRICT); the
  -- identity delete then cascades team + content + reco rows. Audit rows
  -- (admin_id = a person, target_id = team, no FK on target_id) survive.
  update public.teams t
     set owner_id = null
   where t.id = p_identity_id and t.owner_id = p_identity_id;

  delete from public.identities where id = p_identity_id;

  if not found then
    return jsonb_build_object('identity_id', p_identity_id, 'finalized', false, 'reason', 'delete_failed');
  end if;

  return jsonb_build_object('identity_id', p_identity_id, 'finalized', true);
end;
$fn$;

revoke all on function public.finalize_profile_deletion(uuid) from public, anon, authenticated;
grant execute on function public.finalize_profile_deletion(uuid) to service_role;

-- 6) Every profile whose provider objects are all gone is finalized by the
--    drain tail — no manual operator step, no second scheduler.
create or replace function public.finalize_ready_profile_deletions()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_id uuid;
  v_result jsonb;
  v_finalized int := 0;
  v_skipped   int := 0;
begin
  for v_id in
    select i.id
      from public.identities i
     where i.status = 'deleted'
       and i.purge_requested_at is not null
       and not exists (
         select 1 from public.media_cleanup_queue q
          where q.owner_identity_id = i.id
            and q.resolved_at is null
       )
  loop
    v_result := public.finalize_profile_deletion(v_id);
    if (v_result->>'finalized')::boolean then
      v_finalized := v_finalized + 1;
    else
      v_skipped := v_skipped + 1;
    end if;
  end loop;

  return jsonb_build_object('finalized', v_finalized, 'skipped', v_skipped);
end;
$fn$;

revoke all on function public.finalize_ready_profile_deletions() from public, anon, authenticated;
grant execute on function public.finalize_ready_profile_deletions() to service_role;

-- 7) Backfill: deleted team profiles that predate this pipeline. Before the
--    marker is stamped, every provider object their media rows reference MUST
--    be enqueued — finalization destroys the media rows, and only queued
--    objects get purged. (Enqueue first, mark second; active profiles are
--    untouched.)
insert into public.media_cleanup_queue (
  media_id, owner_identity_id, post_id, provider, storage_path, entity_type, slot
)
select m.id, m.owner_identity_id, m.post_id, m.provider, m.storage_path,
       m.entity_type, m.slot
  from public.media m
 where m.owner_identity_id in (
    select i.id from public.identities i
     where i.kind = 'team' and i.status = 'deleted' and i.purge_requested_at is null
   )
on conflict (provider, storage_path) where resolved_at is null
  do nothing;

update public.identities i
   set purge_requested_at = now()
 where i.kind = 'team'
   and i.status = 'deleted'
   and i.purge_requested_at is null;

commit;


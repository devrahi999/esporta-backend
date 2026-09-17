-- Profile Access & Control hardening (live-applied via execute_sql on 2026-09-17).
--
-- Three gaps closed, reusing the existing security architecture:
--
-- 1. Remove Admin had no server-side re-auth: guard_team_member_role covered
--    INSERT/UPDATE that touch the admin role, but the owner's Remove Admin path
--    DELETEs the row. New BEFORE DELETE trigger applies the same owner +
--    recent-reauth rule.
--
-- 2. delete_team was soft-delete only, with no provider-side media purge.
--    purge_team_media(p_team_id) enqueues every media row the team identity
--    owns into the existing media_cleanup_queue; the async drainer
--    (backend internal endpoint) removes the R2 / Stream objects and now also
--    Supabase Storage objects. Cloudinary stays legacy-unreachable: rows exist
--    but no credentials are configured, so objects are not removable — they are
--    enqueued anyway so the drainer records the attempt and skips them.
--
-- 3. Admin access changes were unaudited. log_access_action writes the
--    existing admin_audit_log from an owner context; action names are
--    whitelisted and payloads carry ids/role names only.
--
-- Plus: notify_on_team_membership now fires admin_access_removed at the removed
-- admin when an admin row is DELETEd, and notification_push_payload /
-- notification_types gain the new type.

-- ------------------------------------------------------------- media_provider --
-- Supabase Storage objects can now be cleaned through the same queue.

ALTER TYPE public.media_provider ADD VALUE IF NOT EXISTS 'supabase';

-- ------------------------------------------------------------ revoke trigger --
-- Removing an *active* admin row revokes administrative access, so it gets the
-- same owner + recent-reauth rule the grant path already has. Narrow on
-- purpose, so the legal self-service deletes stay legal:
--  * the row's own identity deleting their seat (an admin stepping down, an
--    invitee declining) needs nobody's permission, least of all a reauth;
--  * pending invitations are offers, not access — cancelling one needs no
--    reauth (the accept side already re-checks the inviter still owns);
--  * the permanent-delete path releases ownership first (owner_id NULL), so a
--    cascade that removes admin rows during account deletion is recognised and
--    never blocks the FK cascade.
-- Only a third party deleting an ACTIVE admin is the owner's reauth-guarded act.

CREATE OR REPLACE FUNCTION public.guard_team_member_revoke()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
begin
  if coalesce(current_setting('esporta.allow_owner_change', true), 'off') = 'on' then
    return old;
  end if;

  if old.role = 'admin'
     and old.status = 'active'
     and old.identity_id <> auth.uid()
     and exists (
       select 1 from public.teams t
        where t.id = old.team_id and t.owner_id is not null
     )
  then
    if not public.is_team_owner(old.team_id, auth.uid()) then
      raise exception 'Only the team owner can remove an admin.'
        using errcode = '42501', hint = 'owner_only';
    end if;
    perform public.assert_recent_reauth('00:15:00');
  end if;

  return old;
end;
$function$;

DROP TRIGGER IF EXISTS team_members_guard_revoke ON public.team_members;
CREATE TRIGGER team_members_guard_revoke
  BEFORE DELETE ON public.team_members
  FOR EACH ROW EXECUTE FUNCTION public.guard_team_member_revoke();

-- ------------------------------------------------------- access audit trail --
-- Staff-driven access changes land in the existing admin_audit_log. The action
-- names are whitelisted; the payload carries ids and role names only.
--
-- Two rules hold the row's integrity, since the caller's identity is what the
-- log stamps as the auditor:
--  * the action must be one of the whitelisted access actions;
--  * the caller must be staff of the team the action is about — its owner, or
--    the holder of an active seat in it. The team id is read from the same
--    `after` payload the service already sends, falling back to the target when
--    that target *is* the team.
--
-- The seat clause is what keeps the transfer case recordable: by the time the
-- row is written, `transfer_team_ownership` has handed ownership on and left the
-- actor as an admin. Likewise `delete_team` leaves `teams.owner_id` alone, so the
-- deleting owner is still recognised after their rows are marked `removed`.

CREATE OR REPLACE FUNCTION public.log_access_action(
  p_action text,
  p_target_type text,
  p_target_id uuid,
  p_after jsonb DEFAULT NULL::jsonb,
  p_note text DEFAULT NULL::text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
declare
  me uuid := auth.uid();
  v_id uuid;
  v_team_id uuid;
  v_allowed constant text[] := array[
    'team_admin_invited',
    'team_admin_accepted',
    'team_admin_declined',
    'team_admin_removed',
    'team_admin_invite_cancelled',
    'ownership_transferred',
    'team_deleted'
  ];
begin
  if me is null then
    raise exception 'Sign in first.' using errcode = '42501';
  end if;
  if not p_action = any (v_allowed) then
    raise exception 'Unknown access action.' using errcode = '22023';
  end if;

  v_team_id := coalesce(
    nullif(p_after ->> 'team_id', '')::uuid,
    case when p_target_type = 'team' then p_target_id end
  );
  if v_team_id is null then
    raise exception 'An access action has to name the team it is about.'
      using errcode = '22023';
  end if;

  if not (
    public.is_team_owner(v_team_id, me)
    or exists (
      select 1 from public.team_members m
       where m.team_id = v_team_id
         and m.identity_id = me
         and m.status = 'active'
    )
  ) then
    raise exception 'Only the team''s own staff can record an access action.'
      using errcode = '42501', hint = 'staff_only';
  end if;

  insert into public.admin_audit_log
    (admin_id, action, target_type, target_id, before_state, after_state, note)
  values
    (me, p_action, p_target_type, p_target_id, null, p_after, p_note)
  returning id into v_id;

  return v_id;
end;
$function$;

-- Staff use only, and the check is enforced inside the function: the row's
-- admin_id is always auth.uid(), so a permissive grant would let anybody write
-- audit rows about a team they have nothing to do with.
grant execute on function public.log_access_action(text, text, uuid, jsonb, text) to service_role, authenticated;

-- --------------------------------------------------------------- team purge --
-- Enqueues every media object owned by the team identity into the existing
-- cleanup queue. Called by the backend just before delete_team; the drainer
-- then empties the queue at its own pace.

CREATE OR REPLACE FUNCTION public.purge_team_media(p_team_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
declare
  v_tasks jsonb;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.is_team_owner(p_team_id, auth.uid()) then
    raise exception 'Only the team owner can purge team media.'
      using errcode = '42501', hint = 'owner_only';
  end if;
  perform public.assert_recent_reauth('00:15:00');

  with enqueued as (
    insert into public.media_cleanup_queue (
      media_id, owner_identity_id, post_id, provider, storage_path, entity_type, slot
    )
    select m.id, m.owner_identity_id, m.post_id, m.provider, m.storage_path,
           m.entity_type, m.slot
      from public.media m
     where m.owner_identity_id = p_team_id
    on conflict (provider, storage_path) where resolved_at is null
      do nothing
    returning id, provider, storage_path, entity_type, slot
  )
  select coalesce(
           jsonb_agg(jsonb_build_object(
             'id', id,
             'provider', provider,
             'storagePath', storage_path,
             'entityType', entity_type,
             'slot', slot
           )),
           '[]'::jsonb
         )
    into v_tasks
    from enqueued;

  return jsonb_build_object('tasks', v_tasks);
end;
$function$;

revoke execute on function public.purge_team_media(uuid) from public, anon;
grant execute on function public.purge_team_media(uuid) to authenticated;

-- ------------------------------------------------------------- reauth check --
-- Read-only companion to assert_recent_reauth: lets the backend (and the app)
-- ask "would this pass?" without raising, so an expired reauth can surface as a
-- clean 403 before the mutating call is attempted. Same window, same source.

CREATE OR REPLACE FUNCTION public.reauth_is_fresh()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path TO ''
AS $function$
declare
  me uuid := auth.uid();
  last_at timestamptz;
begin
  if me is null then
    return false;
  end if;
  select s.last_reauth_at into last_at
    from public.security_settings s
   where s.id = me;
  return last_at is not null and last_at > now() - interval '15 minutes';
end;
$function$;

grant execute on function public.reauth_is_fresh() to authenticated;

-- --------------------------------------------- admin removal notification ---
-- The membership trigger only handled INSERT and status flips; DELETE of an
-- admin row was silent. The removed admin is notified directly; the owner who
-- performed the removal gets no echo of their own action.

CREATE OR REPLACE FUNCTION public.notify_on_team_membership()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
begin
  if tg_op = 'INSERT' then
    if new.status = 'invited' then
      perform public.notify(
        new.identity_id, 'team_invite', new.team_id, 'team_member', new.id
      );
    elsif new.status = 'requested' then
      perform public.notify(
        new.team_id, 'join_request', new.identity_id, 'team_member', new.id
      );
    elsif new.status = 'active' then
      perform public.notify(
        new.team_id, 'team_member_joined', new.identity_id, 'team_member', new.id
      );
    end if;
  elsif tg_op = 'DELETE' then
    if old.role = 'admin' then
      perform public.notify(
        old.identity_id, 'admin_access_removed', old.team_id, 'team_member', old.id
      );
    end if;
  elsif new.status is distinct from old.status then
    if new.status = 'active' then
      perform public.notify(
        new.team_id, 'team_member_joined', new.identity_id, 'team_member', new.id
      );
    elsif new.status in ('left', 'removed') then
      perform public.notify(
        new.team_id, 'team_member_left', new.identity_id, 'team_member', new.id
      );
    end if;
  end if;
  return null;
end;
$function$;

-- The function grew a DELETE branch, but the trigger it hangs off was still
-- INSERT/UPDATE-only — so the branch could never run. Re-declared with the
-- event list the function actually handles: an admin row that is deleted is
-- access being taken away, not a status flip.
DROP TRIGGER IF EXISTS team_members_notify ON public.team_members;
CREATE TRIGGER team_members_notify
  AFTER INSERT OR DELETE OR UPDATE OF status ON public.team_members
  FOR EACH ROW EXECUTE FUNCTION public.notify_on_team_membership();

-- ------------------------------------------------------- notification type ---
insert into public.notification_types (id, label, group_label, actionable, sort_order, active, in_app)
values ('admin_access_removed', 'Admin access removed', 'Teams', false, 16, true, true)
on conflict (id) do nothing;

-- ---------------------------------------------------------- push channel ----
-- A type with no channel here is never queued for a push at all: `push_enqueue`
-- treats the mapping as the allow-list. The new admin-removal type belongs with
-- the rest of the team mail, so the removal reaches the admin's device rather
-- than only the in-app tray.

CREATE OR REPLACE FUNCTION public.notification_push_channel(p_type text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO ''
AS $function$
  select case p_type
    when 'team_invite'            then 'teamInvites'
    when 'join_request'           then 'teamInvites'
    when 'team_member_joined'     then 'teamInvites'
    when 'team_member_left'       then 'teamInvites'
    when 'ownership_transferred'  then 'teamInvites'
    when 'admin_access_removed'   then 'teamInvites'
    when 'added_to_roster'        then 'teamInvites'

    when 'application_received'    then 'applications'
    when 'application_accepted'   then 'applications'
    when 'application_declined'   then 'applications'
    when 'application_shortlisted' then 'applications'
    when 'application_reply'      then 'applications'
    when 'hire_request'           then 'applications'
    when 'hire_interested'        then 'applications'
    when 'hire_declined'          then 'applications'
    when 'tryout_requested'       then 'applications'
    when 'trial_scheduled'        then 'applications'
    when 'tryout_completed'       then 'applications'
    when 'tryout_reminder'        then 'applications'
    when 'sponsorship_request'    then 'applications'
    when 'sponsorship_accepted'   then 'applications'
    when 'sponsorship_declined'   then 'applications'
    when 'sponsorship_ended'      then 'applications'

    when 'post_reaction'          then 'postActivity'
    when 'post_comment'           then 'postActivity'
    when 'comment_reply'          then 'postActivity'
    when 'mention'                then 'postActivity'

    when 'new_follower'           then 'followers'

    when 'new_post'               then 'newPosts'
    when 'new_short'              then 'newPosts'

    when 'login_approval_request' then 'securityAlerts'
    when 'login_approved'         then 'securityAlerts'
    when 'login_denied'           then 'securityAlerts'

    when 'announcement'           then 'productUpdates'
    when 'system_update'          then 'productUpdates'
    when 'support_reply'          then 'productUpdates'
    when 'verification_submitted' then 'productUpdates'
    when 'verification_approved'  then 'productUpdates'
    when 'verification_declined'  then 'productUpdates'
    when 'verification_not_eligible' then 'productUpdates'
    when 'profile_verified'       then 'productUpdates'
    when 'verification_revoked'   then 'productUpdates'
    when 'premium_granted'        then 'productUpdates'
    when 'premium_revoked'        then 'productUpdates'
    when 'account_suspended'      then 'productUpdates'
    when 'account_restored'       then 'productUpdates'
    when 'account_restricted'     then 'productUpdates'
    when 'account_unrestricted'   then 'productUpdates'
    when 'content_removed'        then 'productUpdates'
    when 'achievement_verified'   then 'productUpdates'
    when 'achievement_rejected'   then 'productUpdates'
    else null
  end;
$function$;

-- ---------------------------------------------------------- push payload -----
-- Mirrors 'ownership_transferred': the actor is the team, so the headline is
-- "<team> removed you as an admin". Same body as before plus the new case.

CREATE OR REPLACE FUNCTION public.notification_push_payload(p_type text, p_actor_name text, p_title text, p_body text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO ''
AS $function$
declare
  who   text := coalesce(nullif(btrim(coalesce(p_actor_name, '')), ''), 'Someone');
  title text := nullif(btrim(coalesce(p_title, '')), '');
  body  text := nullif(btrim(coalesce(p_body, '')), '');
  src   text;  -- title line: the source (person, team, or the app)
  evt   text;  -- body line: what happened
begin
  if title is not null then
    return jsonb_build_object('title', title, 'body', coalesce(body, 'Esporta'));
  end if;

  case p_type
    when 'join_request'          then src := who;       evt := 'asked to join your team';
    when 'team_invite'           then src := who;       evt := 'invited you to their team';
    when 'team_member_joined'    then src := who;       evt := 'joined the team';
    when 'team_member_left'      then src := who;       evt := 'left the team';
    when 'ownership_transferred' then src := who;       evt := 'handed the team over to you';
    when 'admin_access_removed'  then src := who;       evt := 'removed you as an admin';
    when 'added_to_roster'       then src := 'Esporta'; evt := 'You were added to a roster';

    when 'new_follower'          then src := who;       evt := 'started following you';
    when 'new_post'              then src := who;       evt := 'shared a new post';
    when 'new_short'             then src := who;       evt := 'posted a new short';
    when 'post_reaction'         then src := who;       evt := 'reacted to your post';
    when 'post_comment'          then src := who;       evt := 'commented on your post';
    when 'comment_reply'         then src := who;       evt := 'replied to your comment';
    when 'mention'               then src := who;       evt := 'mentioned you';

    when 'application_received'    then src := who;       evt := 'applied to your listing';
    when 'application_accepted'    then src := 'Esporta'; evt := 'Your application was accepted';
    when 'application_declined'    then src := 'Esporta'; evt := 'Your application was declined';
    when 'application_shortlisted' then src := 'Esporta'; evt := 'You were shortlisted';
    when 'application_reply'       then src := who;       evt := 'replied about your application';
    when 'hire_request'            then src := who;       evt := 'wants to hire you';
    when 'hire_interested'         then src := who;       evt := 'is interested in your offer';
    when 'hire_declined'           then src := who;       evt := 'turned down your offer';
    when 'tryout_requested'        then src := who;       evt := 'wants you to try out';
    when 'trial_scheduled'         then src := 'Esporta'; evt := 'A tryout was scheduled';
    when 'tryout_completed'        then src := 'Esporta'; evt := 'Your tryout was marked completed';
    when 'tryout_reminder'         then src := who;       evt := 'Reminder about your tryout';

    when 'achievement_verified'      then src := 'Esporta'; evt := 'Your achievement was verified';
    when 'achievement_rejected'      then src := 'Esporta'; evt := 'An achievement could not be verified';
    when 'support_reply'             then src := 'Esporta'; evt := 'Support replied to your ticket';
    when 'profile_verified'          then src := 'Esporta'; evt := 'Your profile is now verified';
    when 'verification_approved'     then src := 'Esporta'; evt := 'Your verification was approved';
    when 'verification_submitted'    then src := 'Esporta'; evt := 'We got your verification request';
    when 'verification_declined'     then src := 'Esporta'; evt := 'Your verification was not approved';
    when 'verification_not_eligible' then src := 'Esporta'; evt := 'Your verification was not approved';
    when 'verification_revoked'      then src := 'Esporta'; evt := 'Your verification was removed';
    when 'premium_granted'           then src := 'Esporta'; evt := 'You received premium recognition';
    when 'premium_revoked'           then src := 'Esporta'; evt := 'Your premium recognition was removed';
    when 'account_suspended'         then src := 'Esporta'; evt := 'Your account was suspended';
    when 'account_restored'          then src := 'Esporta'; evt := 'Your account was restored';
    when 'account_restricted'        then src := 'Esporta'; evt := 'Your account was restricted';
    when 'account_unrestricted'      then src := 'Esporta'; evt := 'A restriction was lifted';
    when 'content_removed'           then src := 'Esporta'; evt := 'Some of your content was removed';

    else
      src := 'Esporta';
      evt := coalesce(
        body,
        (select t.label from public.notification_types t where t.id = p_type),
        'You have a new notification'
      );
  end case;

  return jsonb_build_object('title', src, 'body', coalesce(evt, ''));
end;
$function$;

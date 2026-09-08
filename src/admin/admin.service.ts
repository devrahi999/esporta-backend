import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import type {
  AdminApplicationsQuery,
  AdminAuditQuery,
  AdminCommentsQuery,
  AdminNotificationsQuery,
  AdminPostsQuery,
  AdminRecentPostsQuery,
  AdminRecruitmentsQuery,
  AdminReportsQuery,
  AdminSupportQuery,
  AdminTryoutsQuery,
  AdminUsersQuery,
  AdminVerificationQuery,
  AnnounceDto,
  DecideVerificationDto,
  DisableAdminDto,
  ReorderFaqDto,
  ReorderReferenceDto,
  SendNotificationDto,
  SetPlatformControlDto,
  SetRoleCapabilityDto,
  SetSuspendedDto,
  SetUserRestrictionDto,
  UpsertAdminDto,
  UpsertFaqDto,
  UpsertReferenceDto,
} from './dto/admin.dto';

type Json = unknown;

/**
 * Thin wrappers over the capability-gated `admin_*` RPCs (plan §26). Every RPC
 * self-enforces the required capability via `admin_require`, so these do not
 * re-implement authorization — they map HTTP shapes to RPC params and run as the
 * caller (RLS + capability checks apply). The AdminGuard rejects non-admins early.
 */
@Injectable()
export class AdminService {
  constructor(private readonly supabase: SupabaseService) {}

  private rpc<T = Json>(token: string, fn: string, params: Record<string, unknown> = {}) {
    return this.supabase.rpcAsCaller<T>(token, fn, params);
  }

  // ---- meta / dashboards ----
  me(token: string) { return this.rpc(token, 'admin_me'); }
  dashboard(token: string) { return this.rpc(token, 'admin_dashboard'); }
  timeseries(token: string, days?: number) { return this.rpc(token, 'admin_timeseries', { p_days: days ?? 30 }); }
  funnel(token: string) { return this.rpc(token, 'admin_funnel'); }
  activity(token: string, limit?: number) { return this.rpc(token, 'admin_activity', { p_limit: limit ?? 50 }); }
  settings(token: string) { return this.rpc(token, 'admin_settings'); }
  storageOverview(token: string) { return this.rpc(token, 'admin_storage_overview'); }
  pushOverview(token: string) { return this.rpc(token, 'admin_push_overview'); }
  touch(token: string) { return this.rpc(token, 'admin_touch'); }

  // ---- users / identities ----
  users(token: string, q: AdminUsersQuery) {
    return this.rpc(token, 'admin_users', {
      p_search: q.search ?? null, p_status: q.status ?? null, p_kind: q.kind ?? null,
      p_verified: q.verified ?? null, p_premium: q.premium ?? null, p_restricted: q.restricted ?? null,
      p_sort: q.sort ?? null, p_limit: q.limit ?? 30, p_offset: q.offset ?? 0,
    });
  }
  searchIdentities(token: string, q: string, kind?: string, limit?: number) {
    return this.rpc(token, 'admin_search_identities', { p_q: q, p_kind: kind ?? null, p_limit: limit ?? 20 });
  }
  identityDetail(token: string, id: string) { return this.rpc(token, 'admin_identity_detail', { p_identity: id }); }
  setIdentityStatus(token: string, id: string, status: string, reason?: string) {
    return this.rpc(token, 'admin_set_identity_status', { p_identity: id, p_status: status, p_reason: reason ?? null });
  }
  setVerified(token: string, id: string, verified: boolean, reason?: string) {
    return this.rpc(token, 'admin_set_verified', { p_identity: id, p_verified: verified, p_reason: reason ?? null });
  }
  setPremium(token: string, id: string, premium: boolean, reason?: string) {
    return this.rpc(token, 'admin_set_premium', { p_identity: id, p_premium: premium, p_reason: reason ?? null });
  }
  restrict(token: string, id: string, days: number, reason?: string) {
    return this.rpc(token, 'admin_restrict_identity', { p_identity: id, p_days: days, p_reason: reason ?? null });
  }

  // ---- verification ----
  verificationQueue(token: string, q: AdminVerificationQuery) {
    return this.rpc(token, 'admin_verification_queue', {
      p_kind: q.kind ?? null, p_status: q.status ?? null, p_search: q.search ?? null,
      p_limit: q.limit ?? 30, p_offset: q.offset ?? 0,
    });
  }
  verificationDetail(token: string, id: string) { return this.rpc(token, 'admin_verification_detail', { p_request: id }); }
  /**
   * Decides a verification request.
   *
   * `admin_decide_verification_request` is OVERLOADED in Postgres: an older
   * `(p_request, p_approve boolean, p_note)` and the current
   * `(p_request, p_decision text, p_note, p_cooldown_days)`. This calls the
   * decision-text overload, because the boolean one cannot express
   * `not_eligible` (which carries a 90-day cooldown rather than 7) and has no
   * way to pass a custom cooldown at all — so a console driving the boolean
   * form could only ever approve or plain-reject.
   */
  decideVerification(token: string, id: string, dto: DecideVerificationDto) {
    return this.rpc(token, 'admin_decide_verification_request', {
      p_request: id,
      p_decision: dto.decision,
      p_note: dto.note ?? null,
      p_cooldown_days: dto.cooldown_days ?? null,
    });
  }

  // ---- content ----
  posts(token: string, q: AdminPostsQuery) {
    return this.rpc(token, 'admin_posts', {
      p_kind: q.kind ?? null, p_search: q.search ?? null, p_state: q.state ?? null, p_author: q.author ?? null,
      p_reported: q.reported ?? null, p_sort: q.sort ?? null, p_limit: q.limit ?? 30, p_offset: q.offset ?? 0,
    });
  }
  postDetail(token: string, id: string) { return this.rpc(token, 'admin_post_detail', { p_post: id }); }
  moderatePost(token: string, id: string, action: string, reason?: string) {
    return this.rpc(token, 'admin_moderate_post', { p_post: id, p_action: action, p_reason: reason ?? null });
  }
  comments(token: string, q: AdminCommentsQuery) {
    return this.rpc(token, 'admin_comments', {
      p_search: q.search ?? null, p_state: q.state ?? null, p_author: q.author ?? null, p_post: q.post ?? null,
      p_reported: q.reported ?? null, p_limit: q.limit ?? 30, p_offset: q.offset ?? 0,
    });
  }
  commentDetail(token: string, id: string) { return this.rpc(token, 'admin_comment_detail', { p_comment: id }); }
  moderateComment(token: string, id: string, action: string, reason?: string) {
    return this.rpc(token, 'admin_moderate_comment', { p_comment: id, p_action: action, p_reason: reason ?? null });
  }
  recruitments(token: string, q: AdminRecruitmentsQuery) {
    return this.rpc(token, 'admin_recruitments', {
      p_status: q.status ?? null, p_game: q.game ?? null, p_search: q.search ?? null, p_owner: q.owner ?? null,
      p_limit: q.limit ?? 30, p_offset: q.offset ?? 0,
    });
  }
  recruitmentDetail(token: string, id: string) { return this.rpc(token, 'admin_recruitment_detail', { p_recruitment: id }); }
  moderateRecruitment(token: string, id: string, action: string, reason?: string) {
    return this.rpc(token, 'admin_moderate_recruitment', { p_recruitment: id, p_action: action, p_reason: reason ?? null });
  }
  applications(token: string, q: AdminApplicationsQuery) {
    return this.rpc(token, 'admin_applications', {
      p_kind: q.kind ?? null, p_status: q.status ?? null, p_search: q.search ?? null,
      p_limit: q.limit ?? 30, p_offset: q.offset ?? 0, p_recruitment: q.recruitment ?? null,
    });
  }
  applicationDetail(token: string, id: string) { return this.rpc(token, 'admin_application_detail', { p_application: id }); }
  tryouts(token: string, q: AdminTryoutsQuery) {
    return this.rpc(token, 'admin_tryouts', {
      p_status: q.status ?? null, p_search: q.search ?? null, p_limit: q.limit ?? 30, p_offset: q.offset ?? 0,
    });
  }
  tryoutDetail(token: string, id: string) { return this.rpc(token, 'admin_tryout_detail', { p_tryout: id }); }

  // ---- reports ----
  reports(token: string, q: AdminReportsQuery) {
    return this.rpc(token, 'admin_reports', {
      p_status: q.status ?? null, p_target_type: q.target_type ?? null, p_reason: q.reason ?? null,
      p_search: q.search ?? null, p_sort: q.sort ?? null, p_limit: q.limit ?? 30, p_offset: q.offset ?? 0,
    });
  }
  reportDetail(token: string, id: string) { return this.rpc(token, 'admin_report_detail', { p_report: id }); }
  resolveReport(token: string, id: string, status: string, note?: string) {
    return this.rpc(token, 'admin_resolve_report', { p_report: id, p_status: status, p_note: note ?? null });
  }

  // ---- support ----
  supportTickets(token: string, q: AdminSupportQuery) {
    return this.rpc(token, 'admin_support_tickets', {
      p_status: q.status ?? null, p_search: q.search ?? null, p_limit: q.limit ?? 30, p_offset: q.offset ?? 0,
    });
  }
  supportTicketDetail(token: string, id: string) { return this.rpc(token, 'admin_support_ticket_detail', { p_ticket: id }); }
  replyTicket(token: string, id: string, body: string) { return this.rpc(token, 'admin_reply_ticket', { p_ticket: id, p_body: body }); }
  setTicketStatus(token: string, id: string, status: string, note?: string) {
    return this.rpc(token, 'admin_set_ticket_status', { p_ticket: id, p_status: status, p_note: note ?? null });
  }

  // ---- faq ----
  faqs(token: string) { return this.rpc(token, 'admin_faqs'); }
  upsertFaq(token: string, dto: UpsertFaqDto) {
    return this.rpc(token, 'admin_upsert_faq', { p_id: dto.id ?? null, p_patch: dto.patch, p_note: dto.note ?? null });
  }
  setFaqActive(token: string, id: string, active: boolean, note?: string) {
    return this.rpc(token, 'admin_set_faq_active', { p_id: id, p_active: active, p_note: note ?? null });
  }
  reorderFaq(token: string, dto: ReorderFaqDto) {
    return this.rpc(token, 'admin_reorder_faq', { p_ids: dto.ids, p_note: dto.note ?? null });
  }

  // ---- reference data ----
  upsertReference(token: string, dto: UpsertReferenceDto) {
    return this.rpc(token, 'admin_upsert_reference', { p_kind: dto.kind, p_id: dto.id, p_patch: dto.patch, p_note: dto.note ?? null });
  }
  setReferenceActive(token: string, kind: string, id: string, active: boolean, note?: string) {
    return this.rpc(token, 'admin_set_reference_active', { p_kind: kind, p_id: id, p_active: active, p_note: note ?? null });
  }
  reorderReference(token: string, dto: ReorderReferenceDto) {
    return this.rpc(token, 'admin_reorder_reference', { p_kind: dto.kind, p_ids: dto.ids, p_note: dto.note ?? null });
  }

  // ---- admins / roles ----
  admins(token: string) { return this.rpc(token, 'admin_admins'); }
  capabilityIds(token: string) { return this.rpc(token, 'admin_capability_ids'); }
  capsForLevel(token: string, level: string) { return this.rpc(token, 'admin_caps_for', { p_level: level }); }
  upsertAdmin(token: string, dto: UpsertAdminDto) {
    return this.rpc(token, 'admin_upsert_admin', { p_identity: dto.identity, p_level: dto.level, p_note: dto.note ?? null });
  }
  revokeAdmin(token: string, id: string, note?: string) {
    return this.rpc(token, 'admin_revoke_admin', { p_identity: id, p_note: note ?? null });
  }
  disableAdmin(token: string, id: string, dto: DisableAdminDto) {
    return this.rpc(token, 'admin_disable_admin', { p_identity: id, p_disabled: dto.disabled, p_note: dto.note ?? null });
  }
  setRoleCapability(token: string, dto: SetRoleCapabilityDto) {
    return this.rpc(token, 'admin_set_role_capability', { p_level: dto.level, p_capability: dto.capability, p_enabled: dto.enabled });
  }

  // ---- notifications ----
  notifications(token: string, q: AdminNotificationsQuery) {
    return this.rpc(token, 'admin_notifications', {
      p_type: q.type ?? null, p_search: q.search ?? null, p_unread_only: q.unread_only ?? null,
      p_limit: q.limit ?? 30, p_offset: q.offset ?? 0,
    });
  }
  sendNotification(token: string, dto: SendNotificationDto) {
    return this.rpc(token, 'admin_send_notification', {
      p_recipients: dto.recipients, p_type: dto.type, p_title: dto.title, p_body: dto.body ?? null,
      p_entity: dto.entity ?? null, p_entity_id: dto.entity_id ?? null, p_note: dto.note ?? null,
    });
  }
  announce(token: string, dto: AnnounceDto) {
    return this.rpc(token, 'admin_announce', { p_title: dto.title, p_body: dto.body, p_audience: dto.audience });
  }

  // ---- audit ----
  audit(token: string, q: AdminAuditQuery) {
    return this.rpc(token, 'admin_audit', {
      p_action: q.action ?? null, p_admin: q.admin ?? null, p_target: q.target ?? null, p_target_type: q.target_type ?? null,
      p_search: q.search ?? null, p_since: q.since ?? null, p_limit: q.limit ?? 50, p_offset: q.offset ?? 0,
    });
  }
  auditDetail(token: string, id: string) { return this.rpc(token, 'admin_audit_detail', { p_entry: id }); }

  // ---- platform controls & per-user restrictions (plan Parts 3/4/5) ----
  platformControls(token: string) { return this.rpc(token, 'admin_platform_controls'); }
  setPlatformControl(token: string, key: string, dto: SetPlatformControlDto) {
    return this.rpc(token, 'admin_set_platform_control', {
      p_key: key,
      p_enabled: dto.enabled,
      p_reason: dto.reason ?? null,
      p_message: dto.message ?? null,
      p_eta: dto.eta ?? null,
    });
  }
  userRestrictions(token: string, identity: string) {
    return this.rpc(token, 'admin_user_restrictions', { p_identity: identity });
  }
  setUserRestriction(token: string, identity: string, dto: SetUserRestrictionDto) {
    return this.rpc(token, 'admin_set_user_restriction', {
      p_identity: identity,
      p_feature: dto.feature,
      p_restricted: dto.restricted,
      p_reason: dto.reason ?? null,
      p_expires_at: dto.expiresAt ?? null,
    });
  }
  setSuspended(token: string, identity: string, dto: SetSuspendedDto) {
    return this.rpc(token, 'admin_set_identity_suspended', {
      p_identity: identity,
      p_suspended: dto.suspended,
      p_reason: dto.reason ?? null,
    });
  }
  /** Today's uploads — post-publication review queue (plan Part 5). */
  postsRecent(token: string, q: AdminRecentPostsQuery) {
    return this.rpc(token, 'admin_posts_recent', {
      p_from: q.from ?? null, p_to: q.to ?? null,
      p_kind: q.kind ?? null, p_moderation: q.moderation ?? null,
      p_reported: q.reported ?? null, p_search: q.search ?? null,
      p_limit: q.limit ?? 50, p_offset: q.offset ?? 0,
    });
  }
  moderationStats(token: string) { return this.rpc(token, 'admin_moderation_stats'); }
}

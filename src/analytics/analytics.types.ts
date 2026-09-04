/**
 * The frozen analytics event taxonomy (Analytics Part 1, §2 and §12).
 *
 * These are the ONLY event names the ingestion endpoint accepts — an unknown
 * name is a 400 `INVALID_ANALYTICS_EVENT`, never a silently-accepted row. The
 * list is deliberately short and meaningful: a smaller taxonomy that every
 * consumer understands beats a hundred names nobody queries. Adding an event
 * is a code change here plus a matching Flutter constant, never a runtime
 * free-for-all.
 *
 * Shorts are posts (`posts.type_id = 'short'`), so short events carry
 * `entity_type = 'post'` and are separated by name, not by entity type.
 */
export const ANALYTICS_EVENT_NAMES = [
  // Content
  'post_impression',
  'post_view',
  'post_open',
  'post_reaction',
  'post_comment',
  'post_share',
  'post_save',
  'short_impression',
  'short_view',
  'short_watch',
  'short_watch_25',
  'short_watch_50',
  'short_watch_75',
  'short_complete',
  'short_reaction',
  'short_comment',
  'short_share',
  // Profile / social
  'profile_view',
  'team_view',
  'follow',
  'unfollow',
  'search',
  'search_result_click',
  // Recruitment
  'recruitment_impression',
  'recruitment_view',
  'application_created',
  'hire_request_created',
  // App / session
  'app_open',
  'session_start',
  'session_end',
] as const;

export type AnalyticsEventName = (typeof ANALYTICS_EVENT_NAMES)[number];

/** Entity kinds an event can be about. Shorts are posts, so there is no 'short'. */
export const ANALYTICS_ENTITY_TYPES = ['post', 'identity', 'application'] as const;
export type AnalyticsEntityType = (typeof ANALYTICS_ENTITY_TYPES)[number];

/**
 * Per-event entity requirements (plan §12: "post_view → entity_type = post →
 * entity_id required"). `null` means the event is session-level and must not
 * carry an entity at all — a stray entity_id on app_open is a client bug worth
 * rejecting rather than storing.
 */
export const EVENT_ENTITY_RULES: Record<AnalyticsEventName, { type: AnalyticsEntityType; required: boolean } | null> = {
  post_impression: { type: 'post', required: true },
  post_view: { type: 'post', required: true },
  post_open: { type: 'post', required: true },
  post_reaction: { type: 'post', required: true },
  post_comment: { type: 'post', required: true },
  post_share: { type: 'post', required: true },
  post_save: { type: 'post', required: true },
  short_impression: { type: 'post', required: true },
  short_view: { type: 'post', required: true },
  short_watch: { type: 'post', required: true },
  short_watch_25: { type: 'post', required: true },
  short_watch_50: { type: 'post', required: true },
  short_watch_75: { type: 'post', required: true },
  short_complete: { type: 'post', required: true },
  short_reaction: { type: 'post', required: true },
  short_comment: { type: 'post', required: true },
  short_share: { type: 'post', required: true },
  profile_view: { type: 'identity', required: true },
  team_view: { type: 'identity', required: true },
  follow: { type: 'identity', required: true },
  unfollow: { type: 'identity', required: true },
  search: null,
  search_result_click: { type: 'post', required: false },
  recruitment_impression: { type: 'post', required: true },
  recruitment_view: { type: 'post', required: true },
  application_created: { type: 'application', required: true },
  hire_request_created: { type: 'application', required: true },
  app_open: null,
  session_start: null,
  session_end: null,
};

/** `search_result_click` may point at either a post or the identity it opened. */
const MULTI_ENTITY_EVENTS = new Set<AnalyticsEventName>(['search_result_click']);

/** The platforms the Flutter app can report (plan §1 event model). */
export const ANALYTICS_PLATFORMS = ['android', 'ios', 'web', 'macos', 'windows', 'linux'] as const;

/** Whether this event's entity_type may be any of the known kinds. */
export function allowsAnyEntityType(name: AnalyticsEventName): boolean {
  return MULTI_ENTITY_EVENTS.has(name);
}
/**
 * The canonical Esporta content-moderation and platform-policy vocabulary,
 * mirrored from the database enums (public.moderation_status,
 * platform_settings.key) so TypeScript callers — and the spec tests — share
 * one source of truth instead of re-typing strings.
 *
 * The DATABASE remains authoritative; these constants exist so the backend's
 * own code cannot drift from the vocabulary the SQL enforces.
 */

/** The four moderation statuses. Posts publish immediately ('published');
 * 'under_review' is an investigation flag on ALREADY-PUBLISHED content, never
 * a pre-publication queue; 'restricted' is stored-but-hidden; 'removed' is
 * fully unavailable. */
export type ModerationStatus = 'published' | 'under_review' | 'restricted' | 'removed';

/** Which statuses the public read policy (RLS) lets non-admins see. */
export function moderationReadableByPublic(status: ModerationStatus): boolean {
  return status === 'published' || status === 'under_review';
}

/** The feature switches platform_settings stores — and policy consults. */
export const platformFeatureKeys = [
  'upload_images',
  'upload_videos',
  'upload_shorts',
  'post_creation',
  'comments',
] as const;

export type PlatformFeatureKey = (typeof platformFeatureKeys)[number];

/**
 * Most-restrictive-wins (plan Part 17): a platform emergency OFF can never be
 * overridden by a user-level ON; a user restriction adds limits, never lifts
 * one. Mirrors the SQL in user_restricted().
 */
export function resolveEffectiveFeature(input: {
  platformEnabled: boolean;
  userRestricted: boolean;
}): boolean {
  return input.platformEnabled && !input.userRestricted;
}

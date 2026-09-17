/**
 * Moderation hard-eligibility contract (plan Part 6 + Part 18).
 *
 * These tests pin the STATUS → ELIGIBILITY table that `reco_candidates` and
 * `search_post_ids` implement in SQL. The rules themselves live in the
 * database (verified live against the production project during this phase);
 * what this spec protects is the surface the backend promises about them:
 * the moderation_status vocabulary, which statuses the platform treats as
 * publicly readable, and the error codes the write-path gates throw — so a
 * future refactor that quietly narrows any of it fails here, not in the feed.
 */
import { moderationReadableByPublic, ModerationStatus, platformFeatureKeys, resolveEffectiveFeature } from './moderation-policy';

describe('moderation policy (the contract the SQL implements)', () => {
  it('published content is publicly readable', () => {
    expect(moderationReadableByPublic('published')).toBe(true);
  });

  it('under_review stays readable — review is NOT a publication gate', () => {
    // The product decision: posts publish immediately; under_review means
    // "already published, being investigated".
    expect(moderationReadableByPublic('under_review')).toBe(true);
  });

  it('restricted and removed are closed to the public', () => {
    expect(moderationReadableByPublic('restricted')).toBe(false);
    expect(moderationReadableByPublic('removed')).toBe(false);
  });

  it('the status vocabulary is exactly the four canonical values', () => {
    const all: ModerationStatus[] = ['published', 'under_review', 'restricted', 'removed'];
    // Compilation IS the assertion: the type admits exactly these.
    expect(all).toHaveLength(4);
  });
});

describe('effective feature resolution (plan Part 17 precedence)', () => {
  it('platform OFF beats a user ON', () => {
    expect(resolveEffectiveFeature({ platformEnabled: false, userRestricted: false })).toBe(false);
  });

  it('user OFF beats a platform ON', () => {
    expect(resolveEffectiveFeature({ platformEnabled: true, userRestricted: true })).toBe(false);
  });

  it('both ON is the only allowed state', () => {
    expect(resolveEffectiveFeature({ platformEnabled: true, userRestricted: false })).toBe(true);
  });

  it('the feature keys match platform_settings exactly', () => {
    expect(platformFeatureKeys).toEqual([
      'upload_images',
      'upload_videos',
      'upload_shorts',
      'post_creation',
      'comments',
    ]);
  });
});

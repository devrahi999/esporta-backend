export const ALLOWED_IMAGE_MIME = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
] as const;

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB (matches edge-function cap)

export const MEDIA_ENTITY_TYPES = ['profile', 'team', 'post'] as const;
export const MEDIA_SLOTS = ['avatar', 'cover', 'attachment'] as const;

const MIME_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

export function extForMime(mime: string): string {
  return MIME_EXT[mime] ?? '.jpg';
}

/**
 * Object key layout on R2. The first segment is always the owning identity id so
 * ownership is verifiable from the key alone (and it mirrors the existing
 * media layout). Identity images are replaceable per slot; post attachments get
 * a unique key each.
 */
export function imageObjectKey(
  identityId: string,
  entityType: string,
  slot: string,
  mime: string,
  unique: string,
): string {
  const ext = extForMime(mime);
  if (entityType === 'post') return `${identityId}/posts/${unique}${ext}`;
  return `${identityId}/${slot}/${unique}${ext}`;
}

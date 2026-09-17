import type { SupabaseService } from '../../supabase/supabase.service';

/**
 * The identity ids the caller has blocked or been blocked by (both directions),
 * via the `blocked_identity_ids()` SECURITY DEFINER RPC. Feeds and lists exclude
 * these authors, mirroring the app's client-side block filtering but enforced
 * server-side.
 */
export async function blockedIdentityIds(
  supabase: SupabaseService,
  accessToken: string,
): Promise<string[]> {
  const ids = await supabase.rpcAsCaller<string[] | null>(accessToken, 'blocked_identity_ids');
  return Array.isArray(ids) ? ids : [];
}

/** Formats an id list for a PostgREST `not('col','in','(...)')` filter. */
export function inList(ids: string[]): string {
  return `(${ids.join(',')})`;
}

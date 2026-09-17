import { Injectable } from '@nestjs/common';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { SupabaseService } from '../supabase/supabase.service';
import { AppConfigService } from '../config/app-config.service';
import { MediaService } from '../media/media.service';

/**
 * One claimed row off `media_cleanup_queue`.
 *
 * Mirrors the table (and therefore what `purge_post` / `purge_team_media`
 * enqueue): the provider enum value, the object path the provider knows the
 * object by. The queue carries no provider_uid column, so the drainer re-reads
 * the Stream video uid from the `media` row when one still exists — the normal
 * case, since the queue row is written before the post/identity is deleted.
 */
interface CleanupTask {
  id: string;
  media_id: string | null;
  provider: 'r2' | 'stream' | 'supabase' | 'cloudinary';
  storage_path: string;
  entity_type: string;
  slot: string;
}

export interface DrainSummary {
  ok: true;
  claimed: number;
  purged: number;
  failed: number;
  rounds: number;
  needsAttention: number;
  finalized: number;
  skipped: number;
}

/** Marker so a legacy-provider row stops consuming retries and surfaces. */
class CloudinaryUnreachable extends Error {
  constructor() {
    super('cloudinary credentials not configured (legacy provider, objects unreachable)');
  }
}

/**
 * Marker for rows that can never succeed as-is (a Stream video whose uid is no
 * longer resolvable, an unroutable storage path, a provider this deployment
 * cannot reach). They stay open and visible instead of being resolved — an
 * object is only "gone" when a provider says so.
 */
class UnroutableObject extends Error {}

/**
 * Drains the `media_cleanup_queue`.
 *
 * The queue is written by `purge_post` (single post hard-delete) and
 * `purge_team_media` (profile deletion, called by the teams service just before
 * `delete_team`). Provider removal is idempotent, so a retried row costs a
 * no-op; each row is attempted independently so one failure cannot block the
 * rest — a failed row keeps its queue entry, gets a `last_error`, and the
 * claim function's exponential backoff re-offers it (up to 10 attempts).
 *
 * Provider coverage:
 *  * `r2` — deleted through the existing R2 provider (purgeProviderMedia);
 *  * `stream` — deleted through the Stream provider by the media row's uid; a
 *    row whose uid can no longer be resolved is flagged needs_attention (an
 *    object nobody can address cannot be confirmed destroyed);
 *  * `supabase` — removed from the Storage public buckets (`avatars`,
 *    `covers`, `posts`), bucket derived from the path's first segment, and
 *    re-checked so a silent no-op remove() is never reported as deleted;
 *  * `cloudinary` — legacy provider whose credentials are no longer
 *    configured, so its objects are unreachable from this codebase. The row
 *    is flagged needs_attention rather than resolved: it must remain visible.
 *
 * The drain tail finalizes every profile deletion whose queue is clear
 * (finalize_ready_profile_deletions): hard-deleting the identity once its
 * provider objects are all verifiably gone.
 *
 * Batch-bounded like the push dispatcher to fit Vercel's request model; the
 * same in-DB scheduler (wake trigger + pg_cron) re-invokes the endpoint, and
 * unclaimed rows simply wait for the next drain.
 */
@Injectable()
export class MediaCleanupService {
  /** Public buckets, keyed by their path prefix — the way rows name them. */
  private static readonly STORAGE_BUCKETS = new Set(['avatars', 'covers', 'posts']);

  private readonly storage: SupabaseClient;

  constructor(
    private readonly supabase: SupabaseService,
    private readonly media: MediaService,
    config: AppConfigService,
  ) {
    const { url, serviceRoleKey } = config.supabase;
    this.storage = createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { 'X-Client-Info': 'esporta-backend/media-cleanup' } },
    });
  }

  async drain(): Promise<DrainSummary> {
    let purged = 0;
    let failed = 0;
    let needsAttention = 0;
    let rounds = 0;
    const startedAt = Date.now();

    while (rounds < 20 && Date.now() - startedAt < 50_000) {
      const batch = await this.supabase.rpcAsService<CleanupTask[]>('claim_media_cleanup', {
        p_limit: 50,
      });
      const list = Array.isArray(batch) ? batch : [];
      if (list.length === 0) break;
      rounds++;

      for (const task of list) {
        try {
          await this.removeObject(task);
          await this.markResolved(task.id, null);
          purged++;
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          if (error instanceof CloudinaryUnreachable || error instanceof UnroutableObject) {
            // Unreachable-by-design or unroutable: not a transient failure.
            // The row stays open with needs_attention so the gap is visible
            // and blocks finalization — it is never silently "resolved".
            await this.markNeedsAttention(task.id, reason.slice(0, 500));
            needsAttention++;
          } else {
            await this.markFailed(task.id, reason.slice(0, 500));
          }
          failed++;
        }
      }
    }

    // Automatic final step: every profile marked for purge whose provider
    // objects are all resolved is destroyed here — no operator, no second
    // scheduler. Rows still open (including needs_attention) keep the
    // identity alive inside finalize_profile_deletion's guard.
    const finalize = await this.supabase.rpcAsService<{
      finalized: number;
      skipped: number;
    } | null>('finalize_ready_profile_deletions');
    const finalizedCount = finalize?.finalized ?? 0;
    const skippedCount = finalize?.skipped ?? 0;

    return {
      ok: true,
      claimed: purged + failed,
      purged,
      failed,
      rounds,
      needsAttention,
      finalized: finalizedCount,
      skipped: skippedCount,
    };
  }

  /**
   * Removes one object from its provider. A missing object is success — every
   * provider's delete is idempotent, and a 404 means the job is already done.
   */
  private async removeObject(task: CleanupTask): Promise<void> {
    if (task.provider === 'cloudinary') {
      // Legacy provider, credentials not configured in this environment. Not a
      // transient error: recorded once so the row stops consuming retries.
      throw new CloudinaryUnreachable();
    }

    if (task.provider === 'supabase') {
      const [bucket, ...rest] = task.storage_path.split('/');
      if (!bucket || !MediaCleanupService.STORAGE_BUCKETS.has(bucket) || rest.length === 0) {
        // Unknown bucket (e.g. the unused achievement-proofs bucket) or a path
        // that does not name an object: unroutable from this codebase.
        throw new UnroutableObject(`unroutable supabase storage path: ${task.storage_path}`);
      }
      const objectPath = rest.join('/');
      const { error } = await this.storage.storage.from(bucket).remove([objectPath]);
      if (error && !/not found|does not exist|invalid/i.test(error.message)) {
        // Storage reports a missing object as an error; anything else is a
        // real failure that should keep the row retrying.
        throw error;
      }
      // Verify the object is actually gone before resolving: a remove() that
      // silently no-ops (e.g. a dangling-cache or permission edge) must not be
      // reported as deleted. "Not found" here is success — the job is done.
      const check = await this.storage.storage.from(bucket).list(objectPath.split('/').slice(0, -1).join('/'), {
        limit: 100,
        search: objectPath.split('/').pop(),
      });
      if (check.data?.some((f) => f.name === objectPath.split('/').pop())) {
        throw new Error(`supabase object still present after removal: ${bucket}/${objectPath}`);
      }
      return;
    }

    // r2 / stream go through the existing purger: same key mapping, same
    // idempotency semantics. Stream needs the video uid, which the queue does
    // not carry — re-read it from the media row while it exists.
    let providerUid: string | null = null;
    if (task.provider === 'stream') {
      const row = task.media_id
        ? await this.supabase
            .service()
            .from('media')
            .select('provider_uid')
            .eq('id', task.media_id)
            .maybeSingle()
        : null;
      providerUid = (row?.data?.provider_uid as string | null) ?? null;
      if (!providerUid) {
        // Without its uid the video is no longer addressable: nobody can
        // confirm destruction, so the row must stay open and visible, never
        // resolved-by-assumption.
        throw new UnroutableObject(
          `stream video for media ${task.media_id ?? task.storage_path} has no resolvable uid`,
        );
      }
    }

    const result = await this.media.purgeProviderMedia([
      {
        id: task.id,
        provider: task.provider,
        storage_path: task.storage_path,
        provider_uid: providerUid,
      },
    ]);
    // purgeProviderMedia collects failures instead of throwing (its admin
    // callers destructure `failed`), so a provider-level delete failure would
    // otherwise look like success here and the row would be marked resolved —
    // an object left alive, silently, with finalization free to proceed. A
    // failure is a transient, retryable condition: throw so the row stays
    // open, records last_error, and the claim function's backoff re-offers it.
    const itemFailure = result.failed.find((f) => f.id === task.id);
    if (itemFailure) {
      throw new Error(`provider purge failed: ${itemFailure.reason.slice(0, 300)}`);
    }
  }

  /** Done: the object is gone (confirmed by the provider or verified absent). */
  private async markResolved(id: string, note: string | null): Promise<void> {
    await this.supabase
      .service()
      .from('media_cleanup_queue')
      .update({ resolved_at: new Date().toISOString(), last_error: note, needs_attention: null })
      .eq('id', id);
  }

  /** Attempted and failed; the claim function's backoff will re-offer it. */
  private async markFailed(id: string, error: string): Promise<void> {
    await this.supabase
      .service()
      .from('media_cleanup_queue')
      .update({ last_error: error })
      .eq('id', id);
  }

  /**
   * Permanently blocked (unroutable path, unreachable provider, exhausted
   * retries via fail_media_cleanup): stays open, flagged, and blocks
   * finalization until an operator resolves the underlying cause.
   */
  private async markNeedsAttention(id: string, reason: string): Promise<void> {
    await this.supabase
      .service()
      .from('media_cleanup_queue')
      .update({ needs_attention: true, last_error: reason })
      .eq('id', id);
  }
}

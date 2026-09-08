import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { SupabaseService } from '../supabase/supabase.service';
import { R2Provider } from './providers/r2.provider';
import { StreamProvider } from './providers/stream.provider';
import { AppException } from '../common/errors/app-exception';
import { ErrorCode } from '../common/errors/error-codes';
import { PlatformPolicyService } from '../platform/platform-policy.service';
import {
  ALLOWED_IMAGE_MIME,
  MAX_IMAGE_BYTES,
  imageObjectKey,
} from './media.constants';
import type {
  CompleteImageUploadDto,
  CompleteReplaceDto,
  CreateImageUploadSessionDto,
  CreateVideoUploadSessionDto,
  ReplaceImageSessionDto,
} from './dto/media.dto';

const MEDIA_COLUMNS =
  'id, owner_identity_id, entity_type, entity_id, post_id, slot, media_type, provider, provider_uid, storage_path, public_url, thumbnail_url, mime_type, file_size_bytes, width, height, duration_seconds, upload_status, processing_status, created_at';

type Row = Record<string, unknown> & { id: string };

const DEFAULT_VIDEO_MAX_DURATION = 600; // seconds

/** A short is a post with type_id 'short': exactly one video, no images, ≤ 60 s. */
const SHORT_MAX_DURATION = 60; // seconds

/**
 * R2 image + Cloudflare Stream video orchestration (plan §11–16). Uploads are
 * presigned/direct (client → provider; the backend never proxies bytes). Images
 * are verified with a HEAD at complete; videos are recorded as `processing` and
 * advanced to `ready`/`failed` by the signed Stream webhook. Post attachments are
 * recorded unattached and claimed via `attach_media_to_post`.
 */
@Injectable()
export class MediaService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly r2: R2Provider,
    private readonly stream: StreamProvider,
    private readonly platform: PlatformPolicyService,
  ) {}

  async createImageUploadSession(
    token: string,
    identityId: string,
    dto: CreateImageUploadSessionDto,
  ) {
    // Upload gates (plan Part 15): a presigned URL is a real upload grant, so
    // the switch is enforced HERE, not only at complete-time. Global OFF or a
    // personal restriction refuses before any provider call.
    await this.platform.assertNotSuspended(identityId);
    await this.platform.assertFeatureAllowed(
      identityId,
      'upload_images',
      ErrorCode.UPLOAD_IMAGE_DISABLED,
      'Image uploads are temporarily unavailable.',
    );
    this.validateCombo(dto.entity_type, dto.slot);
    const key = imageObjectKey(identityId, dto.entity_type, dto.slot, dto.content_type, randomUUID());
    const { url, expiresSeconds } = await this.r2.presignPut(key);
    return {
      upload_url: url,
      method: 'PUT',
      key,
      storage_path: this.r2.storagePath(key),
      public_url: this.r2.publicUrl(key),
      expires_in: expiresSeconds,
    };
  }

  async completeImageUpload(
    token: string,
    userId: string,
    identityId: string,
    dto: CompleteImageUploadDto,
  ): Promise<Row> {
    this.validateCombo(dto.entity_type, dto.slot);
    this.assertOwnedKey(dto.key, identityId);
    const head = await this.verifyObject(dto.key);

    const isPost = dto.entity_type === 'post';
    const row = await this.supabase.run<Row>(
      this.supabase
        .asCaller(token)
        .from('media')
        .insert({
          owner_user_id: userId,
          owner_identity_id: identityId,
          entity_type: dto.entity_type,
          entity_id: isPost ? null : identityId,
          post_id: null,
          slot: dto.slot,
          media_type: 'image',
          provider: 'r2',
          storage_path: this.r2.storagePath(dto.key),
          public_url: this.r2.publicUrl(dto.key),
          mime_type: head.contentType,
          file_size_bytes: head.contentLength,
          width: dto.width ?? null,
          height: dto.height ?? null,
          upload_status: 'uploaded',
          processing_status: 'ready',
        })
        .select(MEDIA_COLUMNS)
        .single(),
    );

    // Optionally attach straight to an existing post (via the guarded RPC).
    if (isPost && dto.post_id) {
      await this.supabase.rpcAsCaller(token, 'attach_media_to_post', {
        p_post_id: dto.post_id,
        p_media_ids: [row.id],
      });
      return { ...row, post_id: dto.post_id };
    }
    return row;
  }

  // -------------------------------------------------------------- video (Stream)
  /**
   * Reserves a Cloudflare Stream direct-upload URL and records a `processing`
   * video media row keyed by the Stream UID. The webhook later flips it to
   * ready/failed. The client uploads bytes straight to `upload_url`.
   */
  async createVideoUploadSession(
    token: string,
    userId: string,
    identityId: string,
    dto: CreateVideoUploadSessionDto,
  ): Promise<{ upload_url: string; uid: string; media_id: string; media: Row }> {
    // Upload gates BEFORE any provider reservation (plan Part 15): the
    // direct-upload URL is the actual grant. A session bound to a short post
    // checks the upload_shorts switch; everything else upload_videos.
    await this.platform.assertNotSuspended(identityId);
    let isShortSession = false;
    if (dto.post_id) {
      const post = await this.supabase.run<{ type_id: string } | null>(
        this.supabase
          .asCaller(token)
          .from('posts')
          .select('type_id')
          .eq('id', dto.post_id)
          .maybeSingle(),
      );
      isShortSession = post?.type_id === 'short';
    }
    await this.platform.assertFeatureAllowed(
      identityId,
      isShortSession ? 'upload_shorts' : 'upload_videos',
      isShortSession ? ErrorCode.UPLOAD_SHORTS_DISABLED : ErrorCode.UPLOAD_VIDEO_DISABLED,
      isShortSession
        ? 'Shorts are temporarily unavailable.'
        : 'Video uploads are temporarily unavailable.',
    );

    let maxDuration = dto.max_duration_seconds ?? DEFAULT_VIDEO_MAX_DURATION;

    // Server-side enforcement of the short rule. `duration_seconds` is only
    // populated later by the Stream webhook, so `attach_media_to_post` can
    // never reject an over-length short at attach time — the cap has to live
    // here, where the provider itself refuses anything longer. If the session
    // names a post and that post is a short, the upload cannot exceed 60 s
    // no matter what the client asked for.
    if (dto.post_id) {
      const post = await this.supabase.run<{ type_id: string } | null>(
        this.supabase
          .asCaller(token)
          .from('posts')
          .select('type_id')
          .eq('id', dto.post_id)
          .maybeSingle(),
      );
      if (post && post.type_id === 'short') {
        maxDuration = Math.min(maxDuration, SHORT_MAX_DURATION);
      }
    }

    const { uploadUrl, uid } = await this.stream.createDirectUpload(
      maxDuration,
      { identityId },
    );
    const row = await this.supabase.run<Row>(
      this.supabase
        .asCaller(token)
        .from('media')
        .insert({
          owner_user_id: userId,
          owner_identity_id: identityId,
          entity_type: 'post',
          entity_id: null,
          post_id: null,
          slot: 'attachment',
          media_type: 'video',
          provider: 'stream',
          provider_uid: uid,
          storage_path: `stream/${uid}`,
          public_url: this.stream.hlsUrl(uid),
          thumbnail_url: this.stream.thumbnailUrl(uid),
          upload_status: 'uploading',
          processing_status: 'pending',
        })
        .select(MEDIA_COLUMNS)
        .single(),
    );
    if (dto.post_id) {
      await this.supabase.rpcAsCaller(token, 'attach_media_to_post', {
        p_post_id: dto.post_id,
        p_media_ids: [row.id],
      });
    }
    return { upload_url: uploadUrl, uid, media_id: row.id, media: row };
  }

  /**
   * Applies a Cloudflare Stream webhook (actor-less, service role). Advances the
   * matching video row to ready (with duration/dimensions/thumbnail) or failed;
   * ignores intermediate states.
   */
  async applyStreamWebhook(payload: Record<string, unknown>): Promise<void> {
    const uid = typeof payload.uid === 'string' ? payload.uid : undefined;
    if (!uid) return;
    const state = (payload.status as Record<string, unknown> | undefined)?.state;

    const patch: Record<string, unknown> = {};
    if (state === 'ready') {
      patch.processing_status = 'ready';
      patch.upload_status = 'uploaded';
      if (typeof payload.duration === 'number') patch.duration_seconds = Math.round(payload.duration);
      const input = payload.input as Record<string, unknown> | undefined;
      if (typeof input?.width === 'number') patch.width = input.width;
      if (typeof input?.height === 'number') patch.height = input.height;
      if (typeof payload.thumbnail === 'string') patch.thumbnail_url = payload.thumbnail;
    } else if (state === 'error') {
      patch.processing_status = 'failed';
      patch.upload_status = 'failed';
    } else {
      return; // queued / inprogress / downloading — nothing to persist yet
    }

    await this.supabase.run(
      this.supabase.service().from('media').update(patch).eq('provider', 'stream').eq('provider_uid', uid),
    );
  }

  async delete(token: string, mediaId: string): Promise<{ deleted: true }> {
    const client = this.supabase.asCaller(token);
    const media = await this.supabase.run<Row | null>(
      client.from('media').select('id, provider, provider_uid, storage_path').eq('id', mediaId).maybeSingle(),
    );
    if (!media) throw AppException.notFound('Media not found.');

    if (media.provider === 'r2') {
      await this.r2.delete(this.keyFromPath(String(media.storage_path)));
    } else if (media.provider === 'stream') {
      if (media.provider_uid) await this.stream.deleteVideo(String(media.provider_uid));
    } else {
      throw AppException.conflict(
        'This media is on a legacy provider; delete it through the existing media pipeline.',
      );
    }
    await this.supabase.run(client.from('media').delete().eq('id', mediaId));
    return { deleted: true };
  }

  async replaceSession(token: string, identityId: string, mediaId: string, dto: ReplaceImageSessionDto) {
    const existing = await this.loadOwnR2Media(token, mediaId);
    const key = imageObjectKey(
      identityId,
      String(existing.entity_type),
      String(existing.slot),
      dto.content_type,
      randomUUID(),
    );
    this.assertOwnedKey(key, identityId);
    const { url, expiresSeconds } = await this.r2.presignPut(key);
    return {
      upload_url: url,
      method: 'PUT',
      key,
      storage_path: this.r2.storagePath(key),
      public_url: this.r2.publicUrl(key),
      expires_in: expiresSeconds,
    };
  }

  async completeReplace(
    token: string,
    identityId: string,
    mediaId: string,
    dto: CompleteReplaceDto,
  ): Promise<Row> {
    const existing = await this.loadOwnR2Media(token, mediaId);
    this.assertOwnedKey(dto.key, identityId);
    const head = await this.verifyObject(dto.key);
    const oldKey = this.keyFromPath(String(existing.storage_path));

    const updated = await this.supabase.run<Row>(
      this.supabase
        .asCaller(token)
        .from('media')
        .update({
          storage_path: this.r2.storagePath(dto.key),
          public_url: this.r2.publicUrl(dto.key),
          mime_type: head.contentType,
          file_size_bytes: head.contentLength,
          width: dto.width ?? null,
          height: dto.height ?? null,
        })
        .eq('id', mediaId)
        .select(MEDIA_COLUMNS)
        .single(),
    );
    // Remove the superseded object only after the row points at the new one.
    if (oldKey && oldKey !== dto.key) {
      await this.r2.delete(oldKey).catch(() => undefined);
    }
    return updated;
  }

  // --------------------------------------------------------------- helpers
  private validateCombo(entityType: string, slot: string): void {
    const ok =
      entityType === 'post' ? slot === 'attachment' : slot === 'avatar' || slot === 'cover';
    if (!ok) {
      throw AppException.validation(`Slot "${slot}" is not valid for entity "${entityType}".`);
    }
  }

  private assertOwnedKey(key: string, identityId: string): void {
    if (!key.startsWith(`${identityId}/`)) {
      throw AppException.forbidden('That upload key does not belong to your profile.');
    }
  }

  private async verifyObject(key: string): Promise<{ contentType: string; contentLength: number }> {
    const head = await this.r2.head(key);
    if (!head.exists) {
      throw AppException.badRequest('Upload not found — PUT the file to the presigned URL first.');
    }
    const type = head.contentType ?? '';
    if (!(ALLOWED_IMAGE_MIME as readonly string[]).includes(type)) {
      await this.r2.delete(key).catch(() => undefined);
      throw AppException.validation(`Unsupported image type: ${type || 'unknown'}.`);
    }
    if (head.contentLength !== undefined && head.contentLength > MAX_IMAGE_BYTES) {
      await this.r2.delete(key).catch(() => undefined);
      throw AppException.validation('Image exceeds the 10 MB limit.');
    }
    return { contentType: type, contentLength: head.contentLength ?? 0 };
  }

  private async loadOwnR2Media(token: string, mediaId: string): Promise<Row> {
    const media = await this.supabase.run<Row | null>(
      this.supabase
        .asCaller(token)
        .from('media')
        .select('id, provider, storage_path, entity_type, slot')
        .eq('id', mediaId)
        .maybeSingle(),
    );
    if (!media) throw AppException.notFound('Media not found.');
    if (media.provider !== 'r2') {
      throw AppException.conflict('Only R2-stored media can be replaced through this endpoint.');
    }
    return media;
  }

  private keyFromPath(storagePath: string): string {
    const idx = storagePath.indexOf('/');
    return idx === -1 ? storagePath : storagePath.slice(idx + 1);
  }
}

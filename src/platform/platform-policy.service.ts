import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { AppException } from '../common/errors/app-exception';
import { ErrorCode } from '../common/errors/error-codes';

/**
 * The one policy evaluator for platform-wide controls, per-user feature
 * restrictions, account suspension and maintenance mode (plan Parts 3, 4, 16,
 * 17).
 *
 * The DATABASE is the source of truth: `platform_settings`,
 * `user_feature_restrictions` and `identities.status` decide everything. This
 * service only reads them (via the service-role RPCs, which are STABLE and
 * cheap) and translates the answer into typed exceptions carrying stable
 * machine codes the app maps to friendly messages.
 *
 * Precedence (Part 17): platform emergency restriction > account suspension >
 * user-specific restriction > normal permission. `user_restricted()` already
 * folds the platform layer and the user layer into one boolean; suspension is
 * checked separately because it is an account state, not a feature.
 */

/** Feature keys — must match platform_settings / user_feature_restrictions. */
export type PlatformFeature =
  | 'upload_images'
  | 'upload_videos'
  | 'upload_shorts'
  | 'post_creation'
  | 'comments';

interface PlatformState {
  maintenance: boolean;
  maintenance_message: string | null;
  maintenance_eta: string | null;
  features: Record<string, boolean>;
}

/** What the app bootstrap needs in order to adapt its UI (Part 16). */
export interface EffectivePlatformState extends PlatformState {
  /** Caller-specific effective gates, maintenance already folded in. */
  effective: Record<PlatformFeature, boolean>;
}

@Injectable()
export class PlatformPolicyService {
  /** 60s TTL: every request consulting policy should not hit Postgres twice. */
  private stateCache: { at: number; value: PlatformState } | null = null;
  private static readonly CACHE_MS = 60_000;

  constructor(private readonly supabase: SupabaseService) {}

  private async state(): Promise<PlatformState> {
    const now = Date.now();
    if (this.stateCache && now - this.stateCache.at < PlatformPolicyService.CACHE_MS) {
      return this.stateCache.value;
    }
    const value = await this.supabase.rpcAsService<PlatformState>('platform_state');
    const resolved: PlatformState = {
      maintenance: !!value?.maintenance,
      maintenance_message: value?.maintenance_message ?? null,
      maintenance_eta: value?.maintenance_eta ?? null,
      features: value?.features ?? {},
    };
    this.stateCache = { at: now, value: resolved };
    return resolved;
  }

  /**
   * The full effective state for one identity — what the app bootstrap and
   * the client use to enable/disable creation surfaces (Part 16). The server
   * still enforces every write; this is the display/UX mirror.
   */
  async effectiveFor(identityId: string | null): Promise<EffectivePlatformState> {
    const base = await this.state();
    const features = base.features;
    const effective: Record<PlatformFeature, boolean> = {
      upload_images: !!features.upload_images,
      upload_videos: !!features.upload_videos,
      upload_shorts: !!features.upload_shorts,
      post_creation: !!features.post_creation,
      comments: !!features.comments,
    };
    if (identityId) {
      const gates = await this.restrictionsFor(identityId, [
        'upload_images',
        'upload_videos',
        'upload_shorts',
        'post_creation',
        'comments',
      ]);
      for (const key of Object.keys(gates) as PlatformFeature[]) {
        // Most-restrictive-wins (Part 17): global OFF hides the control even
        // when the user has no personal restriction, and vice versa.
        effective[key] = effective[key] && !gates[key];
      }
    }
    return { ...base, effective };
  }

  /** Raw `user_restricted()` lookups for a set of features (one round trip). */
  async restrictionsFor(
    identityId: string,
    features: PlatformFeature[],
  ): Promise<Record<PlatformFeature, boolean>> {
    const out: Partial<Record<PlatformFeature, boolean>> = {};
    // One RPC per feature is a candidate-list anti-pattern, but policy gates
    // run on WRITE paths (create post, start upload, add comment) — single
    // requests, not per-candidate loops. Reads for dashboards use the admin
    // RPCs which resolve in SQL.
    await Promise.all(
      features.map(async (f) => {
        const restricted = await this.supabase.rpcAsService<boolean>('user_restricted', {
          p_identity: identityId,
          p_feature: f,
        });
        out[f] = !!restricted;
      }),
    );
    return out as Record<PlatformFeature, boolean>;
  }

  /**
   * Maintenance gate for normal app operations (Part 3). Admin operations
   * never call this — the admin surface stays reachable during maintenance by
   * design.
   */
  async assertNotMaintenance(): Promise<void> {
    const s = await this.state();
    if (!s.maintenance) return;
    throw AppException.maintenance(
      'Esporta is temporarily unavailable. Please try again later.',
      s.maintenance_message ?? undefined,
      s.maintenance_eta ?? undefined,
    );
  }

  /**
   * The write-path feature gate: maintenance first (an emergency stop should
   * stop everything), then the feature's effective switch (global + user).
   */
  async assertFeatureAllowed(
    identityId: string,
    feature: PlatformFeature,
    codeWhenDisabled: string,
    friendlyWhenDisabled: string,
  ): Promise<void> {
    await this.assertNotMaintenance();

    const s = await this.state();
    if (s.features[feature] === false) {
      throw AppException.forbidden(friendlyWhenDisabled, codeWhenDisabled);
    }

    const restricted = await this.supabase.rpcAsService<boolean>('user_restricted', {
      p_identity: identityId,
      p_feature: feature,
    });
    if (restricted) {
      throw AppException.forbidden(friendlyWhenDisabled, codeWhenDisabled);
    }
  }

  /**
   * Suspension check (Part 4): suspended accounts may not perform protected
   * application activity. Runs on every guarded write path together with the
   * feature gates.
   */
  async assertNotSuspended(identityId: string): Promise<void> {
    const rows = await this.supabase.run<{ status: string } | null>(
      this.supabase
        .service()
        .from('identities')
        .select('status')
        .eq('id', identityId)
        .maybeSingle(),
    );
    if (rows?.status === 'suspended') {
      throw AppException.forbidden(
        'Your account is currently suspended.',
        ErrorCode.USER_SUSPENDED,
      );
    }
  }

  /** Invalidate the cached platform state after an admin control change. */
  invalidateCache(): void {
    this.stateCache = null;
  }
}

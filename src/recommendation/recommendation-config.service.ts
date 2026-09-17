import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { SupabaseService } from '../supabase/supabase.service';
import { AppException } from '../common/errors/app-exception';
import { AppLogger } from '../common/logger/app-logger';
import {
  DEFAULT_RECOMMENDATION_CONFIG,
  validateRecommendationConfig,
  type ConfigValidationResult,
  type RecommendationConfig,
} from './config/recommendation-config.schema';
import type { RecommendationConfigProviderPort } from './core/types';

/** The label used when no active version exists and defaults are serving. */
export const FALLBACK_VERSION_LABEL = 'built-in-defaults';
export const FALLBACK_VERSION_ID = '00000000-0000-0000-0000-000000000000';

interface ActiveConfigRow {
  version_id: string;
  version_label: string;
  config_hash: string;
  activated_at: string | null;
  config: unknown;
}

interface CachedConfig {
  config: RecommendationConfig;
  versionId: string;
  versionLabel: string;
  fallback: boolean;
  expiresAt: number;
}

/**
 * Resolves the active recommendation configuration, and owns the version
 * lifecycle (§21, §22).
 *
 * THE FALLBACK IS THE IMPORTANT PART. Ranking must never fail because
 * configuration is missing, unreadable or invalid — that would take Home and
 * Shorts down for a config problem. Every failure path here degrades to
 * {@link DEFAULT_RECOMMENDATION_CONFIG}, which is derived from the schema and so
 * is guaranteed valid. The response still carries a version label
 * (`built-in-defaults`), so a fallback is *visible* in logs and traceable rather
 * than silently indistinguishable from a real version.
 *
 * A stored version is re-validated on read, not trusted. A row written before a
 * schema change, or by an older deploy, can be out of bounds — and an out-of-
 * bounds weight is exactly what the bounds exist to stop from reaching ranking.
 */
@Injectable()
export class RecommendationConfigService implements RecommendationConfigProviderPort {
  private cache: CachedConfig | null = null;
  private readonly logger = new AppLogger('RecommendationConfig');

  constructor(private readonly supabase: SupabaseService) {}

  /**
   * The active config, cached in process for `shared.configCacheSeconds`.
   *
   * The TTL is short by design. On Vercel each instance holds its own cache and
   * there is no cross-instance invalidation channel (introducing Redis for this
   * alone is exactly the over-engineering §36 forbids), so a short TTL *is* the
   * invalidation mechanism: an activation is fully live within one TTL on every
   * instance. {@link invalidate} makes it immediate on the instance that
   * performed the activation.
   */
  async active(): Promise<{
    config: RecommendationConfig;
    versionId: string;
    versionLabel: string;
    fallback: boolean;
  }> {
    const now = Date.now();
    if (this.cache && this.cache.expiresAt > now) {
      const { config, versionId, versionLabel, fallback } = this.cache;
      return { config, versionId, versionLabel, fallback };
    }

    const resolved = await this.load();
    const ttlSeconds = resolved.config.shared.configCacheSeconds;
    this.cache = { ...resolved, expiresAt: now + ttlSeconds * 1000 };
    return resolved;
  }

  /** Drops the cached config so the next read re-resolves. */
  invalidate(): void {
    this.cache = null;
  }

  private async load(): Promise<{
    config: RecommendationConfig;
    versionId: string;
    versionLabel: string;
    fallback: boolean;
  }> {
    let row: ActiveConfigRow | null = null;
    try {
      row = await this.supabase.rpcAsService<ActiveConfigRow | null>('reco_active_config');
    } catch (error) {
      // A database problem must not take ranking down.
      this.logger.event('active config read failed; using defaults', {
        context: 'RecommendationConfig',
        errorCode: 'CONFIG_READ_FAILED',
        reason: error instanceof Error ? error.message : 'unknown',
      });
      return this.fallback();
    }

    if (!row) {
      // No active version yet — the expected state before the first activation.
      return this.fallback();
    }

    const validation = validateRecommendationConfig(row.config);
    if (!validation.valid || !validation.config) {
      this.logger.event('active config failed validation; using defaults', {
        context: 'RecommendationConfig',
        errorCode: 'CONFIG_INVALID',
        versionId: row.version_id,
        versionLabel: row.version_label,
        issues: validation.issues.slice(0, 10),
      });
      return this.fallback();
    }

    return {
      config: validation.config,
      versionId: row.version_id,
      versionLabel: row.version_label,
      fallback: false,
    };
  }

  private fallback() {
    return {
      config: DEFAULT_RECOMMENDATION_CONFIG,
      versionId: FALLBACK_VERSION_ID,
      versionLabel: FALLBACK_VERSION_LABEL,
      fallback: true,
    };
  }

  // ----------------------------------------------------------- admin surface
  // Explicit domain operations only (§24). There is deliberately no
  // "patch arbitrary key" or "set score" entry point: every write goes through
  // full schema validation, so a bounded slider is the only shape an admin
  // panel can express.

  /**
   * Validates a draft without storing it — the admin panel's "check before
   * publish" affordance. Returns all issues, not just the first.
   */
  validateDraft(input: unknown): ConfigValidationResult {
    return validateRecommendationConfig(input);
  }

  /** The active version plus its config, for the admin panel. */
  async activeVersion(): Promise<unknown> {
    return this.supabase.rpcAsService('reco_active_config');
  }

  async history(limit: number, offset: number): Promise<unknown> {
    return this.supabase.rpcAsService('reco_config_history', {
      p_limit: limit,
      p_offset: offset,
    });
  }

  async version(versionId: string): Promise<unknown> {
    const row = await this.supabase.rpcAsService('reco_config_version', {
      p_version_id: versionId,
    });
    if (!row) throw AppException.notFound('Recommendation config version not found.');
    return row;
  }

  async auditLog(limit: number, offset: number): Promise<unknown> {
    return this.supabase.rpcAsService('reco_config_audit_log', {
      p_limit: limit,
      p_offset: offset,
    });
  }

  /**
   * Creates a DRAFT version from a validated document.
   *
   * Validation happens here rather than in SQL because the schema — with its
   * bounds and cross-field rules — is TypeScript. An invalid draft is rejected
   * with every issue listed and an audit row is written, so a refused change is
   * as traceable as an accepted one.
   *
   * The stored document is the PARSED config (defaults materialised), not the
   * caller's input: a version must be reproducible on its own, so a partial
   * document that would inherit different defaults after a schema change is not
   * a valid snapshot.
   */
  async createDraft(params: {
    label: string;
    config: unknown;
    notes?: string;
    actorUserId: string;
  }): Promise<unknown> {
    const validation = validateRecommendationConfig(params.config);
    if (!validation.valid || !validation.config) {
      throw AppException.validation('Recommendation config is invalid.', {
        issues: validation.issues,
      });
    }

    const normalised = validation.config;
    const hash = createHash('sha256')
      .update(JSON.stringify(normalised))
      .digest('hex')
      .slice(0, 32);

    return this.supabase.rpcAsService('reco_config_create', {
      p_version_label: params.label,
      p_config: normalised,
      p_config_hash: hash,
      p_notes: params.notes ?? null,
      p_actor: params.actorUserId,
    });
  }

  /**
   * Activates a version (or rolls back to an older one — the same operation,
   * distinguished only in the audit trail).
   *
   * The stored config is re-validated BEFORE activation: a row that no longer
   * satisfies the current schema must not become active, or the provider would
   * fall back to defaults on every read while the panel reported a live version.
   */
  async activate(params: {
    versionId: string;
    actorUserId: string;
    note?: string;
    rollback?: boolean;
  }): Promise<unknown> {
    const target = (await this.supabase.rpcAsService<{ config?: unknown } | null>(
      'reco_config_version',
      { p_version_id: params.versionId },
    )) as { config?: unknown } | null;
    if (!target) throw AppException.notFound('Recommendation config version not found.');

    const validation = validateRecommendationConfig(target.config);
    if (!validation.valid) {
      throw AppException.unprocessable(
        'That config version no longer satisfies the current schema and cannot be activated.',
        undefined,
        { issues: validation.issues },
      );
    }

    const result = await this.supabase.rpcAsService('reco_config_activate', {
      p_version_id: params.versionId,
      p_actor: params.actorUserId,
      p_note: params.note ?? null,
      p_rollback: params.rollback ?? false,
    });

    // Immediate on this instance; other instances pick it up within one TTL.
    this.invalidate();
    return result;
  }
}

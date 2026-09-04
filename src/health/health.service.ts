import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { SupabaseService } from '../supabase/supabase.service';

export type Status = 'ok' | 'degraded' | 'down' | 'not_configured';

export interface CheckResult {
  status: Status;
  detail?: string;
  latencyMs?: number;
}

const startedAt = Date.now();

/**
 * Health checks for Vercel monitoring (plan §34). `/health` is a cheap liveness
 * ping; the sub-checks report dependency status. Integration checks report
 * `not_configured` (not an error) when their secrets are absent, so the backend
 * can go live before every provider is wired during the shadow migration.
 */
@Injectable()
export class HealthService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly config: AppConfigService,
  ) {}

  liveness() {
    return {
      status: 'ok' as const,
      service: 'esporta-backend',
      env: this.config.nodeEnv,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      timestamp: new Date().toISOString(),
    };
  }

  /** Pings Postgres via a tiny read against a stable lookup table. */
  async database(): Promise<CheckResult> {
    const t = Date.now();
    try {
      const { error } = await this.supabase
        .service()
        .from('post_types')
        .select('id', { count: 'exact', head: true });
      if (error) return { status: 'down', detail: error.message, latencyMs: Date.now() - t };
      return { status: 'ok', latencyMs: Date.now() - t };
    } catch (e) {
      return { status: 'down', detail: e instanceof Error ? e.message : String(e), latencyMs: Date.now() - t };
    }
  }

  /** R2 configuration status (reachability probe added when the R2 provider lands in Phase 5). */
  storage(): CheckResult {
    const r2 = this.config.r2;
    return r2.configured
      ? { status: 'ok', detail: `bucket=${r2.bucket}` }
      : { status: 'not_configured', detail: 'R2 credentials not set' };
  }

  /** Cloudflare Stream configuration status. */
  stream(): CheckResult {
    return this.config.stream.configured
      ? { status: 'ok' }
      : { status: 'not_configured', detail: 'Cloudflare Stream credentials not set' };
  }

  /**
   * SMTP *configuration* status only. Deliberately not a live connect: `/health`
   * is public, and probing Gmail on every uptime ping would burn the provider's
   * rate limit and hand anyone a way to make us dial out. The live connect +
   * auth probe is `POST /api/v1/webhooks/internal/email-diagnostics`, behind the
   * dispatch secret.
   */
  email(): CheckResult {
    const s = this.config.smtp;
    if (s.configured) {
      return { status: 'ok', detail: `host=${s.host} port=${s.port}` };
    }
    const missing = [
      !s.host && 'SMTP_HOST',
      !s.username && 'SMTP_USERNAME',
      !s.password && 'SMTP_PASSWORD',
    ].filter(Boolean);
    return { status: 'not_configured', detail: `missing: ${missing.join(', ')}` };
  }

  /** Roll-up of every dependency for a single dashboard call. */
  async full() {
    const [db] = await Promise.all([this.database()]);
    return {
      ...this.liveness(),
      checks: {
        database: db,
        storage: this.storage(),
        stream: this.stream(),
        push: this.config.firebase.configured ? { status: 'ok' as const } : { status: 'not_configured' as const },
        email: this.email(),
      },
    };
  }
}

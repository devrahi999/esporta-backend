/**
 * Rate-limit tier registry (STEP 1 security baseline).
 *
 * Every tier's requests-per-minute value comes ONLY from a `RATE_LIMIT_*` env
 * var, parsed and bounded in `src/config/env.validation.ts` — there are no
 * numeric literals at call sites, so ops can retune limits on Vercel without a
 * deploy. The `fallbackPerMinute` values below mirror those env defaults and
 * exist purely so the type can require a complete mapping.
 */
import type { Type } from '@nestjs/common';
export interface RateLimitTier {
  /** Stable tier key; names the counter so budgets never cross classes. */
  readonly name: string;
  /** Env var (requests/minute) that tunes this tier. */
  readonly envVar: string;
  /** Mirrors the env default; documentation of intent, not a runtime value. */
  readonly fallbackPerMinute: number;
}

export const RATE_LIMIT_TIERS = {
  /** `POST /auth/login` — the credential-stuffing surface. Strictest tier. */
  login: {
    name: 'login',
    envVar: 'AUTH_LOGIN_RATE_LIMIT',
    fallbackPerMinute: 10,
  },
  /** Signed-out account-recovery OTP endpoints (anti-enumeration throttle). */
  accountRecovery: {
    name: 'account-recovery',
    envVar: 'RECOVERY_RATE_LIMIT',
    fallbackPerMinute: 10,
  },
  /** Signature-gated provider webhooks + secret-gated internal jobs. */
  webhook: {
    name: 'webhook',
    envVar: 'WEBHOOK_RATE_LIMIT',
    fallbackPerMinute: 120,
  },
  /** Public analytics event ingestion (batched by the app, up to 50/batch). */
  analyticsIngest: {
    name: 'analytics-ingest',
    envVar: 'ANALYTICS_RATE_LIMIT',
    fallbackPerMinute: 60,
  },
  /** Upload session minting/completion (each presign is an upload grant). */
  media: {
    name: 'media',
    envVar: 'MEDIA_RATE_LIMIT',
    fallbackPerMinute: 30,
  },
  /** High-churn read surfaces (public profiles, search, health). */
  public: {
    name: 'public',
    envVar: 'PUBLIC_RATE_LIMIT',
    fallbackPerMinute: 120,
  },
  /** Everything else, including the authenticated admin consoles. */
  default: {
    name: 'default',
    envVar: 'DEFAULT_RATE_LIMIT',
    fallbackPerMinute: 60,
  },
} as const satisfies Record<string, RateLimitTier>;

export type RateLimitTierName = keyof typeof RATE_LIMIT_TIERS;

/**
 * Controller class → tier. Anything NOT listed here gets the `default` tier;
 * only deviations from default are mapped so the table stays an exception
 * list. Class names (not route paths) are used because the global throttler
 * classifies at the handler level and route strings drift with refactors.
 */
const CONTROLLER_TIERS: Readonly<Partial<Record<string, RateLimitTierName>>> = {
  AuthController: 'login',
  AccountRecoveryController: 'accountRecovery',
  WebhooksController: 'webhook',
  InternalController: 'webhook',
  AnalyticsController: 'analyticsIngest',
  MediaController: 'media',
  PublicController: 'public',
  SearchController: 'public',
};

/** Resolves the tier for a handler's controller class. */
export function resolveTier(controllerClass: Type<unknown> | undefined): RateLimitTier {
  const name = controllerClass ? CONTROLLER_TIERS[controllerClass.name] : undefined;
  return RATE_LIMIT_TIERS[name ?? 'default'];
}
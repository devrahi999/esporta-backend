import { Injectable, Inject, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  getOptionsToken,
  getStorageToken,
  ThrottlerGuard,
} from '@nestjs/throttler';
import type {
  ThrottlerModuleOptions,
  ThrottlerRequest,
  ThrottlerStorage,
} from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AppConfigService } from '../../config/app-config.service';
import { AppException } from '../errors/app-exception';
import { clientIpOf } from '../http/client-ip';
import { resolveTier } from '../http/rate-limit.tiers';

const MINUTE_MS = 60_000;

/**
 * Global rate limiter (STEP 1 security baseline) — the one place request
 * throttling is defined. Extends `@nestjs/throttler`'s guard but classifies
 * every request into a tier from {@link ../http/rate-limit.tiers} and reads the
 * tier's limit from validated env config, so no limit is ever hardcoded at a
 * call site and ops can retune via Vercel env vars alone.
 *
 * Design notes:
 * - One counter window per (tier, client IP). A caller exhausting the login
 *   tier does not consume the default tier's budget, and vice versa.
 * - The window is a fixed minute, matching the `_per_minute` semantics of the
 *   `RATE_LIMIT_*` variables documented in `.env.example`.
 * - In-memory storage (the throttler's default) is per-serverless-instance by
 *   nature; it blunts abusive loops and accidental floods but is NOT a
 *   distributed quota. If precision matters later, swap in a shared
 *   `ThrottlerStorage` implementation — this guard is the only place that
 *   touches storage.
 * - Throttled requests throw {@link AppException.rateLimited} so the global
 *   exception filter emits the standard envelope with the stable
 *   `RATE_LIMITED` error code Flutter already knows.
 */
@Injectable()
export class EsportaThrottlerGuard extends ThrottlerGuard {
  protected readonly headerPrefix = 'X-RateLimit';

  constructor(
    @Inject(getOptionsToken()) options: ThrottlerModuleOptions,
    @Inject(getStorageToken()) storageService: ThrottlerStorage,
    reflector: Reflector,
    private readonly config: AppConfigService,
  ) {
    super(options, storageService, reflector);
  }

  /**
   * Health endpoints are exempt: uptime monitors must never observe a 429, or
   * a throttled incident looks like an outage.
   */
  protected async shouldSkip(context: ExecutionContext): Promise<boolean> {
    return context.getClass().name === 'HealthController';
  }

  /** Proxy-aware client tracking (see {@link clientIpOf} for trust notes). */
  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    return clientIpOf(req as unknown as Request);
  }

  /**
   * Runs once per request (the module registers exactly one named throttler);
   * resolves the tier for the handler's controller, enforces its env-driven
   * limit, stamps `X-RateLimit-*`, and throws the standard 429 when exceeded.
   */
  protected async handleRequest(requestProps: ThrottlerRequest): Promise<boolean> {
    const { context, blockDuration } = requestProps;
    const tier = resolveTier(context.getClass());
    const limit = this.config.rateLimit.tiers[tier.name] ?? this.config.rateLimit.defaultPerMinute;
    const ttl = MINUTE_MS;

    const req = context.switchToHttp().getRequest<Request>();
    const tracker = await this.getTracker(req as unknown as Record<string, unknown>);
    // Class-and-tier-scoped key: budgets never cross controller classes.
    const key = this.generateKey(context, tracker, tier.name);

    const { totalHits, timeToExpire, isBlocked, timeToBlockExpire } =
      await this.storageService.increment(key, ttl, limit, blockDuration, tier.name);

    const res = context.switchToHttp().getResponse<Response>();
    res.setHeader(`${this.headerPrefix}-Limit`, limit);
    res.setHeader(`${this.headerPrefix}-Remaining`, Math.max(0, limit - totalHits));
    res.setHeader(`${this.headerPrefix}-Reset`, Math.ceil(timeToExpire / 1000));

    if (isBlocked || totalHits > limit) {
      if (isBlocked) {
        res.setHeader('Retry-After', Math.ceil(timeToBlockExpire / 1000));
      }
      throw AppException.rateLimited();
    }
    return true;
  }
}
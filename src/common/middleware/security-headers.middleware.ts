import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

/**
 * Baseline security headers for every API response (STEP 1). Deliberately a
 * middleware rather than `helmet`'s defaults so the policy is explicit and
 * reviewable in-repo, and so nothing here can ever break a JSON API client.
 *
 * Not set here, on purpose:
 * - `Content-Security-Policy`: this service returns JSON only; browsers are not
 *   the primary consumer. Revisit if HTML surfaces are ever served.
 * - `Strict-Transport-Security` is set ONLY when the request arrived over
 *   HTTPS (directly or via a trusted proxy marker) — HSTS on an http:// local
 *   dev origin would poison the browser for localhost.
 */
@Injectable()
export class SecurityHeadersMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    // Never sniff a JSON body into an executable type.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // The API is never meant to be framed (clickjacking hardening).
    res.setHeader('X-Frame-Options', 'DENY');
    // No referrer leakage from any browser-rendered API surface.
    res.setHeader('Referrer-Policy', 'no-referrer');
    // Process-isolation hardening (helmet's modern defaults).
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Origin-Agent-Cluster', '?1');
    res.setHeader('X-DNS-Prefetch-Control', 'off');
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
    // No browser feature access from any embedded view of the API.
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    // Media (R2 images, Stream HLS) is consumed cross-origin by the app/web
    // viewers, so CORP stays permissive here; `same-site` would still allow
    // the first-party clients while blocking arbitrary sites.
    res.setHeader('Cross-Origin-Resource-Policy', 'same-site');

    const forwardedProto = req.headers['x-forwarded-proto'];
    const isHttps =
      (req as { secure?: boolean }).secure === true ||
      (typeof forwardedProto === 'string' && forwardedProto.split(',')[0].trim() === 'https');
    if (isHttps) {
      // 180 days; includeSubDomains, no preload (domain set is still evolving).
      res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    }
    next();
  }
}
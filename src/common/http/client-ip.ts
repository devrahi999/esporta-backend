import type { Request } from 'express';

const PRIVATE_OR_PROXY = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^0\./,
  /^::1$/,
  /^::$/,
  /^f[cd][0-9a-f]{2}:/i,
  /^fe80:/i,
];

function isPrivateOrProxy(addr: string): boolean {
  return PRIVATE_OR_PROXY.some((re) => re.test(addr));
}

/**
 * Best-effort client IP for rate limiting.
 *
 * Order of trust:
 *  1. `req.ip` — Express resolves this from the socket of whoever connected to
 *     us. On Vercel that socket belongs to the platform's edge proxy, and the
 *     platform injects the real client address, so this IS the client IP on
 *     the deployment target. `app.set('trust proxy', 1)` (bootstrap) keeps the
 *     same semantics for any fronting proxy that is trusted.
 *  2. The `X-Forwarded-For` chain, walked right-to-left, taking the rightmost
 *     non-private hop. Only reached when `req.ip` is somehow empty, which
 *     already means no proxy was trusted — so the chain is untrusted and this
 *     is a best guess, never a guarantee.
 *  3. `'unknown'` — all per-IP counters share one bucket in this degenerate
 *     case (fail closed to shared throttling, never to no throttling).
 *
 * Header spoofing note: a client CAN send `X-Forwarded-For` and influence case
 * 2 — but not case 1, which is what production actually uses. The value here
 * is a throttling key, not an identity: never log it as a user attribute or
 * use it for authorization.
 */
export function clientIpOf(req: Request): string {
  const direct = req.ip ?? req.socket?.remoteAddress;
  if (direct && direct.length > 0) return direct;

  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    const hops = xff
      .split(',')
      .map((h) => h.trim())
      .filter((h) => h.length > 0);
    for (let i = hops.length - 1; i >= 0; i--) {
      const hop = hops[i];
      if (hop && !isPrivateOrProxy(hop)) return hop;
    }
    return hops[0] ?? 'unknown';
  }
  return 'unknown';
}
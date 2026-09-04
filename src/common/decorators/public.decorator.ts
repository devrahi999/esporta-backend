import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'esporta:isPublic';

/**
 * Marks a route (or controller) as reachable without authentication. The global
 * JWT guard skips anything flagged with this — health checks, webhooks with
 * their own signature gate, and the signed-out recovery endpoints.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

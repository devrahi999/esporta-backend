import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from '../auth.service';

/**
 * Authenticates the request *if* it carries a bearer token, and lets it through
 * either way.
 *
 * For routes whose data is public but is *richer* for a signed-in caller. The
 * reference catalogue is the case it exists for: the login and signup screens
 * need games, roles and ranks before an account exists, and a signed-in caller
 * additionally sees their own inactive custom entries. Requiring a token there
 * made a cold start fail with "Missing bearer token." and left every picker on
 * the pre-auth screens empty.
 *
 * Pair it with `@Public()`, which switches off the mandatory global guard; this
 * then fills in the user context opportunistically so the handler can tell the
 * two cases apart.
 *
 * **An invalid or expired token is treated as anonymous, not as an error.** That
 * is the whole contract of an optional guard, and it grants nothing: the handler
 * gets the `anon` client, which is strictly less privileged than any caller's.
 * Never put this on a route that would leak something to `anon`.
 */
@Injectable()
export class OptionalAuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest<Request>();

    // No header at all: nothing to verify, and nothing to report.
    if (!this.auth.extractToken(req)) return true;

    try {
      await this.auth.authenticate(req);
    } catch {
      // A token that does not verify leaves the request anonymous. Swallowed on
      // purpose: on a public route the caller has not asked to be identified, so
      // a stale token should degrade the response, not fail it.
    }
    return true;
  }
}

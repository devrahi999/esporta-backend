import { Injectable, Logger } from '@nestjs/common';
import type { Request } from 'express';
import { SupabaseService } from '../supabase/supabase.service';
import { AppException } from '../common/errors/app-exception';
import { ErrorCode } from '../common/errors/error-codes';
import {
  contextOf,
  type AuthenticatedUser,
} from '../common/http/request-context';
import { isUuid } from '../common/utils/uuid';
import { LoginThrottleService } from './login-throttle.service';
import { createHash } from 'node:crypto';

const ACTIVE_PROFILE_HEADER = 'x-active-profile-id';

/** Account-level backoff message; paired with a `Retry-After` hint in details. */
const LOGIN_DELAYED_MESSAGE = 'Too many sign-in attempts. Please wait before trying again.';

/**
 * Turns the request's `Authorization: Bearer <jwt>` into a verified user and
 * resolves which profile the request acts as (plan §6–7).
 *
 * The backend NEVER trusts a client-supplied user id or profile id: the user
 * comes from the verified JWT, and the active profile — if it is not the caller's
 * own personal identity — is checked with `can_act_as`, the same predicate the
 * RLS policies use.
 */
@Injectable()
export class AuthService {
  private readonly log = new Logger(AuthService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly loginThrottle: LoginThrottleService,
  ) {}

  /**
   * The single authentication boundary (admin consoles + Flutter sign-in).
   *
   * Two protections layer here:
   * - account-level progressive backoff BEFORE the credential check (PHASE 3):
   *   enforced for every sign-in against an account in its delay window,
   *   regardless of which IP asks — closing the STEP 1 gap where rotating IPs
   *   defeated per-IP throttling for a targeted account;
   * - a failure message that NEVER repeats GoTrue's wording (PHASE 12): the
   *   upstream text varies ("Email not confirmed", "Invalid login credentials")
   *   and would let a caller probe account/verification state, so the client
   *   always gets one generic line while the specific reason is server-logged
   *   with a keyed correlation hash (never the email itself, never the password).
   */
  async login(dto: { email: string; password: string }, clientIp?: string) {
    const delay = this.loginThrottle.delayFor(dto.email);
    if (delay > 0) {
      throw AppException.rateLimited(LOGIN_DELAYED_MESSAGE, {
        retryAfterMs: delay,
      });
    }

    const { data, error } = await this.supabase.anon().auth.signInWithPassword({
      email: dto.email,
      password: dto.password,
    });

    if (error || !data.session) {
      this.loginThrottle.recordFailure(dto.email);
      // Correlation key lets operators join server logs without the raw email
      // (privacy) — and no password material ever reaches this line.
      const correlation = createHash('sha256')
        .update(dto.email.trim().toLowerCase())
        .digest('hex')
        .slice(0, 12);
      this.log.warn(
        `login failed reason="${error?.message ?? 'no session returned'}" ` +
          `account=${correlation} ip=${clientIp ?? 'unknown'}`,
      );
      throw AppException.unauthenticated('Invalid email or password.');
    }

    this.loginThrottle.recordSuccess(dto.email);
    return data.session;
  }

  extractToken(req: Request): string | undefined {
    const header = req.headers['authorization'];
    if (typeof header !== 'string') return undefined;
    const [scheme, token] = header.split(' ');
    if (!token || scheme.toLowerCase() !== 'bearer') return undefined;
    const trimmed = token.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  /** Verifies the JWT and stores the user + token on the request context. */
  async authenticate(req: Request): Promise<AuthenticatedUser> {
    const token = this.extractToken(req);
    if (!token) {
      throw AppException.unauthenticated('Missing bearer token.');
    }
    const user = await this.supabase.verifyAccessToken(token);
    if (!user) {
      throw AppException.unauthenticated('Invalid or expired token.', ErrorCode.INVALID_TOKEN);
    }

    const authUser: AuthenticatedUser = {
      id: user.id,
      email: user.email ?? undefined,
      role: user.role ?? undefined,
      sessionId:
        typeof (user.app_metadata as Record<string, unknown>)?.session_id === 'string'
          ? ((user.app_metadata as Record<string, unknown>).session_id as string)
          : undefined,
      claims: user as unknown as Record<string, unknown>,
    };

    const ctx = contextOf(req);
    ctx.accessToken = token;
    ctx.user = authUser;
    return authUser;
  }

  /**
   * Resolves the active profile for this request. Defaults to the caller's own
   * personal identity (`user.id`). A different target must pass `can_act_as`
   * (self OR team owner/admin), otherwise PROFILE_FORBIDDEN.
   */
  async resolveActiveProfile(req: Request, user: AuthenticatedUser): Promise<string> {
    const ctx = contextOf(req);
    const header = req.headers[ACTIVE_PROFILE_HEADER];
    const raw = typeof header === 'string' ? header.trim() : '';
    const target = raw.length > 0 ? raw : user.id;

    if (!isUuid(target)) {
      throw AppException.badRequest('Invalid active profile id.', ErrorCode.PROFILE_FORBIDDEN);
    }

    if (target !== user.id) {
      if (!ctx.accessToken) {
        throw AppException.unauthenticated();
      }
      const allowed = await this.supabase.rpcAsCaller<boolean>(
        ctx.accessToken,
        'can_act_as',
        { target_identity: target },
      );
      if (allowed !== true) {
        throw AppException.forbidden('You cannot act as that profile.', ErrorCode.PROFILE_FORBIDDEN);
      }
    }

    ctx.activeProfileId = target;
    return target;
  }
}

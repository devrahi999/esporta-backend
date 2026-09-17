import { Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { SupabaseService } from '../supabase/supabase.service';
import { AppException } from '../common/errors/app-exception';
import { ErrorCode } from '../common/errors/error-codes';
import {
  contextOf,
  type AuthenticatedUser,
} from '../common/http/request-context';
import { isUuid } from '../common/utils/uuid';

const ACTIVE_PROFILE_HEADER = 'x-active-profile-id';

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
  constructor(private readonly supabase: SupabaseService) {}

  async login(dto: { email: string; password: string }) {
    const { data, error } = await this.supabase.anon().auth.signInWithPassword({
      email: dto.email,
      password: dto.password,
    });
    if (error) {
      throw AppException.unauthenticated(error.message);
    }
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

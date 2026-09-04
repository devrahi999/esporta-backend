import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AppException } from '../errors/app-exception';
import type {
  AuthenticatedUser,
  EsportaRequest,
} from '../http/request-context';

function reqOf(ctx: ExecutionContext): EsportaRequest {
  return ctx.switchToHttp().getRequest<EsportaRequest>();
}

/** The verified user. Throws UNAUTHENTICATED if the route wasn't guarded. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const user = reqOf(ctx).esporta?.user;
    if (!user) throw AppException.unauthenticated();
    return user;
  },
);

/** The caller's raw access token, for building an RLS-scoped Supabase client. */
export const AccessToken = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const token = reqOf(ctx).esporta?.accessToken;
    if (!token) throw AppException.unauthenticated();
    return token;
  },
);

/**
 * The resolved active profile id. Requires `ActiveProfileGuard` on the route;
 * throws if it wasn't run so misuse fails loudly instead of acting as the wrong
 * profile.
 */
export const ActiveProfileId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const id = reqOf(ctx).esporta?.activeProfileId;
    if (!id) {
      throw AppException.forbidden('Active profile not resolved for this route.');
    }
    return id;
  },
);

/** The current request id (for correlating client-side logs, etc.). */
export const RequestId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => reqOf(ctx).esporta?.requestId ?? '',
);

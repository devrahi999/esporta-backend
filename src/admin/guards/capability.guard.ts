import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SupabaseService } from '../../supabase/supabase.service';
import { AppException } from '../../common/errors/app-exception';
import type { EsportaRequest } from '../../common/http/request-context';

export const CAPABILITY_KEY = 'esporta_capability';
export const Capability = (capability: string) =>
  SetMetadata(CAPABILITY_KEY, capability);

/**
 * Per-route capability check for admin routes whose RPCs cannot self-gate —
 * the analytics read functions are `SECURITY DEFINER` without an
 * `admin_require` line, so the HTTP layer is where `analytics.view` is
 * enforced. AdminGuard must also run (it is what proves the caller is an admin
 * at all); this guard narrows an admin to a capability.
 *
 * The check itself is `admin_caps(actor)` in the database — the same function
 * every RLS policy and `admin_require` consults — evaluated on the caller's
 * own token. A forged header, a tampered client, a direct RPC: all answer to
 * the database, not to this file.
 */
@Injectable()
export class CapabilityGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly supabase: SupabaseService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const capability = this.reflector.get<string>(
      CAPABILITY_KEY,
      context.getHandler(),
    );
    if (!capability) return true;

    const req = context.switchToHttp().getRequest<EsportaRequest>();
    const token = req.esporta?.accessToken;
    if (!token) throw AppException.unauthenticated();

    let caps: unknown;
    try {
      caps = await this.supabase.rpcAsCaller<string[]>(token, 'admin_caps');
    } catch {
      throw AppException.forbidden('Admin access required.');
    }

    if (!Array.isArray(caps) || !caps.includes(capability)) {
      throw AppException.forbidden(
        `The ${capability} capability is required for this.`,
      );
    }
    return true;
  }
}

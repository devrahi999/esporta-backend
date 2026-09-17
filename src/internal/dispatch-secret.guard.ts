import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { SupabaseService } from '../supabase/supabase.service';
import { AppException } from '../common/errors/app-exception';

/**
 * Gate for machine→backend internal calls (the DB's pg_net dispatches and the
 * external cron-job.org scheduler that triggers the analytics aggregation).
 *
 * The candidate secret arrives either as the `x-dispatch-secret` header — the
 * canonical form, used by pg_net / edge-function callers and by cron-job.org,
 * which can set custom headers — or as `Authorization: Bearer <secret>`, kept
 * for schedulers that cannot. Both are verified through the same
 * `verify_dispatch_secret` RPC: the secret lives in a schema PostgREST does
 * not expose and never leaves Postgres, so a wrong guess is indistinguishable
 * from any other failure and nothing is comparable client-side.
 */
@Injectable()
export class DispatchSecretGuard implements CanActivate {
  constructor(private readonly supabase: SupabaseService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    let candidate: string | undefined;

    const header = req.headers['x-dispatch-secret'];
    candidate = Array.isArray(header) ? header[0] : header;

    if (!candidate) {
      // Vercel Cron: `Authorization: Bearer <secret>`.
      const auth = req.headers['authorization'];
      const bearer = Array.isArray(auth) ? auth[0] : auth;
      if (bearer?.startsWith('Bearer ')) {
        candidate = bearer.slice('Bearer '.length).trim();
      }
    }

    if (!candidate) throw AppException.unauthenticated('Missing dispatch secret.');

    const ok = await this.supabase.rpcAsService<boolean>('verify_dispatch_secret', {
      p_candidate: candidate,
    });
    if (ok !== true) throw AppException.unauthenticated('Invalid dispatch secret.');
    return true;
  }
}

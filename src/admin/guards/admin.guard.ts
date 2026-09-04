import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { SupabaseService } from '../../supabase/supabase.service';
import { AppException } from '../../common/errors/app-exception';
import type { EsportaRequest } from '../../common/http/request-context';

/**
 * Gates the whole `/admin` surface: the caller must be a live admin (per
 * `admin_me`). The individual `admin_*` RPCs still enforce their specific
 * capability, but this rejects non-admins early with a clean 403 instead of
 * leaking which capability was missing.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly supabase: SupabaseService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<EsportaRequest>();
    const token = req.esporta?.accessToken;
    if (!token) throw AppException.unauthenticated();

    let me: unknown;
    try {
      me = await this.supabase.rpcAsCaller(token, 'admin_me');
    } catch {
      throw AppException.forbidden('Admin access required.');
    }
    const ok = !!me && (typeof me !== 'object' || Object.keys(me as object).length > 0);
    if (!ok) throw AppException.forbidden('Admin access required.');
    return true;
  }
}

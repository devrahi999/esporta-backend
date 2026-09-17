import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { AuthService } from '../auth.service';
import { AppException } from '../../common/errors/app-exception';
import type { EsportaRequest } from '../../common/http/request-context';

/**
 * Opt-in guard for routes that act as a profile. Runs after {@link JwtAuthGuard},
 * reads `X-Active-Profile-Id`, and validates it with `can_act_as` — so a caller
 * cannot drive another account's or team's data by spoofing the header
 * (plan §7). Apply with `@UseGuards(ActiveProfileGuard)`.
 */
@Injectable()
export class ActiveProfileGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<EsportaRequest>();
    const user = req.esporta?.user;
    if (!user) throw AppException.unauthenticated();
    await this.auth.resolveActiveProfile(req, user);
    return true;
  }
}

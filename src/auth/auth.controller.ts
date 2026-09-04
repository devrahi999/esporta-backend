import { Controller, Get, UseGuards } from '@nestjs/common';
import {
  ActiveProfileId,
  CurrentUser,
} from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/http/request-context';
import { ActiveProfileGuard } from './guards/active-profile.guard';

/**
 * Auth introspection. `GET /api/v1/auth/me` verifies the whole chain
 * (JWT → user → active profile) and echoes the resolved identity back — handy
 * for the Flutter client to confirm a session and its acting profile.
 */
@Controller('auth')
export class AuthController {
  @Get('me')
  @UseGuards(ActiveProfileGuard)
  me(
    @CurrentUser() user: AuthenticatedUser,
    @ActiveProfileId() activeProfileId: string,
  ) {
    return {
      user: { id: user.id, email: user.email, role: user.role },
      activeProfileId,
      isPersonal: activeProfileId === user.id,
    };
  }
}

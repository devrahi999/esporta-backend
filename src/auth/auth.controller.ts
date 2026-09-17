import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import {
  ActiveProfileId,
  CurrentUser,
} from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import type { AuthenticatedUser } from '../common/http/request-context';
import { ActiveProfileGuard } from './guards/active-profile.guard';
import { AuthLoginDto } from './dto/auth.dto';

/**
 * Auth introspection. `GET /api/v1/auth/me` verifies the whole chain
 * (JWT → user → active profile) and echoes the resolved identity back — handy
 * for the Flutter client to confirm a session and its acting profile.
 *
 * `POST /api/v1/auth/login` is the single authentication boundary for the
 * admin consoles, allowing them to remain completely ignorant of Supabase.
 */
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  login(@Body() dto: AuthLoginDto) {
    return this.auth.login(dto);
  }

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

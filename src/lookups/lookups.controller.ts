import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { LookupsService } from './lookups.service';
import {
  RegisterGameDto,
  RegisterGameRoleDto,
  RegisterRoleDto,
} from './dto/lookup.dto';
import {
  AccessToken,
  OptionalAccessToken,
  OptionalUserId,
} from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { OptionalAuthGuard } from '../auth/guards/optional-auth.guard';

/**
 * `/api/v1/lookups`. Reference data for the whole app, plus custom game/role
 * registration (returns the new slug/id).
 */
@Controller('lookups')
export class LookupsController {
  constructor(private readonly lookups: LookupsService) {}

  /**
   * The catalogue. **Readable without a session, and that is required rather than
   * convenient:** the app loads reference data during startup, before any
   * sign-in, because the login and signup screens render its games, roles, ranks
   * and categories. While this demanded a token, a cold start answered
   * `401 Missing bearer token.` and every one of those pickers was empty.
   *
   * A signed-in caller gets more, not different: `OptionalAuthGuard` verifies a
   * token when one is sent, which is what lets the service add the caller's own
   * inactive custom entries. That is also why the app re-reads this on sign-in.
   *
   * Nothing here is private — RLS grants `anon` SELECT on all seven tables. The
   * three registration routes below stay fully protected.
   */
  @Public()
  @UseGuards(OptionalAuthGuard)
  @Get()
  all(
    @OptionalAccessToken() token: string | undefined,
    @OptionalUserId() userId: string | undefined,
  ) {
    return this.lookups.all(token, userId);
  }

  @Post('games')
  async registerGame(@AccessToken() token: string, @Body() dto: RegisterGameDto) {
    return { id: await this.lookups.registerGame(token, dto.name) };
  }

  @Post('roles')
  async registerRole(@AccessToken() token: string, @Body() dto: RegisterRoleDto) {
    return { id: await this.lookups.registerRole(token, dto.label) };
  }

  @Post('game-roles')
  async registerGameRole(@AccessToken() token: string, @Body() dto: RegisterGameRoleDto) {
    return { id: await this.lookups.registerGameRole(token, dto.game_id, dto.label) };
  }
}

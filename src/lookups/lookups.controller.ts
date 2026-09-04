import { Body, Controller, Get, Post } from '@nestjs/common';
import { LookupsService } from './lookups.service';
import {
  RegisterGameDto,
  RegisterGameRoleDto,
  RegisterRoleDto,
} from './dto/lookup.dto';
import {
  AccessToken,
  CurrentUser,
} from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/http/request-context';

/**
 * `/api/v1/lookups`. Reference data for the whole app, plus custom game/role
 * registration (returns the new slug/id).
 */
@Controller('lookups')
export class LookupsController {
  constructor(private readonly lookups: LookupsService) {}

  @Get()
  all(@AccessToken() token: string, @CurrentUser() user: AuthenticatedUser) {
    return this.lookups.all(token, user.id);
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

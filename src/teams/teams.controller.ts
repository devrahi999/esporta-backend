import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import { TeamsService } from './teams.service';
import {
  CreateTeamDto,
  InviteMemberDto,
  SaveTeamAchievementsDto,
  SaveTeamProfileDto,
  SetMemberRoleDto,
  TransferOwnerDto,
} from './dto/team.dto';
import {
  AccessToken,
  CurrentUser,
} from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/http/request-context';
import { AppException } from '../common/errors/app-exception';
import { isUuid } from '../common/utils/uuid';

function assertUuid(id: string, label: string): void {
  if (!isUuid(id)) throw AppException.validation(`Invalid ${label}.`);
}

/**
 * `/api/v1/teams`. Profile + lifecycle actions self-authorise inside their RPCs
 * (owner/admin via `can_act_as`); membership ops are RLS-guarded. Member-row
 * routes are declared before `:id` routes to avoid param shadowing.
 */
@Controller('teams')
export class TeamsController {
  constructor(private readonly teams: TeamsService) {}

  @Post()
  create(@AccessToken() token: string, @Body() dto: CreateTeamDto) {
    return this.teams.create(token, dto);
  }

  @Get('mine')
  mine(@AccessToken() token: string, @CurrentUser() user: AuthenticatedUser) {
    return this.teams.myMemberships(token, user.id);
  }

  @Post('members/:memberId/accept')
  accept(@AccessToken() token: string, @Param('memberId') memberId: string) {
    assertUuid(memberId, 'member id');
    return this.teams.acceptMember(token, memberId);
  }

  @Patch('members/:memberId/role')
  setRole(@AccessToken() token: string, @Param('memberId') memberId: string, @Body() dto: SetMemberRoleDto) {
    assertUuid(memberId, 'member id');
    return this.teams.setMemberRole(token, memberId, dto.role);
  }

  @Delete('members/:memberId')
  removeMember(@AccessToken() token: string, @Param('memberId') memberId: string) {
    assertUuid(memberId, 'member id');
    return this.teams.removeMember(token, memberId);
  }

  @Get(':id/members')
  members(@AccessToken() token: string, @Param('id') id: string) {
    assertUuid(id, 'team id');
    return this.teams.members(token, id);
  }

  @Post(':id/members')
  invite(
    @AccessToken() token: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: InviteMemberDto,
  ) {
    assertUuid(id, 'team id');
    return this.teams.invite(token, user.id, id, dto.identity_id, dto.role, dto.game_role_slug);
  }

  @Post(':id/join')
  join(@AccessToken() token: string, @CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    assertUuid(id, 'team id');
    return this.teams.requestToJoin(token, id, user.id);
  }

  @Post(':id/transfer-owner')
  transfer(@AccessToken() token: string, @Param('id') id: string, @Body() dto: TransferOwnerDto) {
    assertUuid(id, 'team id');
    return this.teams.transferOwner(token, id, dto.new_owner);
  }

  @Post(':id/leave')
  leave(@AccessToken() token: string, @Param('id') id: string) {
    assertUuid(id, 'team id');
    return this.teams.leave(token, id);
  }

  @Put(':id/achievements')
  saveAchievements(@AccessToken() token: string, @Param('id') id: string, @Body() dto: SaveTeamAchievementsDto) {
    assertUuid(id, 'team id');
    return this.teams.saveAchievements(token, id, dto.achievements);
  }

  @Get(':id')
  getById(@AccessToken() token: string, @Param('id') id: string) {
    assertUuid(id, 'team id');
    return this.teams.getById(token, id);
  }

  @Patch(':id')
  saveProfile(@AccessToken() token: string, @Param('id') id: string, @Body() dto: SaveTeamProfileDto) {
    assertUuid(id, 'team id');
    return this.teams.saveProfile(token, id, dto);
  }

  @Delete(':id')
  remove(@AccessToken() token: string, @Param('id') id: string) {
    assertUuid(id, 'team id');
    return this.teams.delete(token, id);
  }
}

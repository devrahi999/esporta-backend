import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Put,
  Query,
} from '@nestjs/common';
import { ProfilesService } from './profiles.service';
import {
  FollowingVisibilityDto,
  ReplaceGamesDto,
  SaveProfileDto,
} from './dto/profile.dto';
import {
  AccessToken,
  CurrentUser,
} from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import type { AuthenticatedUser } from '../common/http/request-context';
import { AppException } from '../common/errors/app-exception';
import { isUuid } from '../common/utils/uuid';

/**
 * `/api/v1/profiles`. Personal-profile reads and writes; the acting subject is
 * always the signed-in user (team profiles live under `/teams`).
 */
@Controller('profiles')
export class ProfilesController {
  constructor(private readonly profiles: ProfilesService) {}

  @Get('me')
  me(@AccessToken() token: string, @CurrentUser() user: AuthenticatedUser) {
    return this.profiles.getById(token, user.id);
  }

  /**
   * Handle availability, for the username field in signup, the Google username
   * picker and other-profile creation.
   *
   * `@Public()` on purpose: signup checks a handle *before* the account exists,
   * so there is no session to authenticate with. Requiring a JWT here is what
   * made the check unanswerable on the one screen that needs it most. It leaks
   * nothing — the underlying RPC is SECURITY DEFINER, already granted to `anon`,
   * and returns a bare boolean.
   *
   * `u` is canonical; `candidate` and `username` are accepted so no client is
   * coupled to one spelling of the parameter.
   */
  @Public()
  @Get('username-available')
  async usernameAvailable(
    @Query('u') u?: string,
    @Query('candidate') candidate?: string,
    @Query('username') username?: string,
  ) {
    const value = (u ?? candidate ?? username ?? '').trim();
    if (!value) throw AppException.validation('Query param "u" (username) is required.');
    return { available: await this.profiles.usernameAvailable(value) };
  }

  @Patch('me')
  saveMe(@AccessToken() token: string, @Body() patch: SaveProfileDto) {
    return this.profiles.save(token, patch);
  }

  @Put('me/games')
  replaceGames(
    @AccessToken() token: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: ReplaceGamesDto,
  ) {
    return this.profiles.replaceGames(token, user.id, body.games);
  }

  /**
   * "Show following count" — a per-profile privacy preference.
   *
   * `:id` is an **identity** id, personal or team, because the preference lives
   * on `identities` next to `verified` and `premium`. That is also why it is one
   * route rather than one per profile kind: a player hiding it and the team that
   * player runs hiding it are the same write to the same column, and the
   * `set_following_count_visible` RPC answers "may I" with `can_act_as` — self
   * for a personal profile, owner or admin for a team.
   *
   * Deliberately not folded into `PATCH /profiles/me`: that maps to
   * `save_profile`, which is keyed on `auth.uid()` and so could never set a
   * team's.
   */
  @Put(':id/following-visibility')
  setFollowingVisibility(
    @AccessToken() token: string,
    @Param('id') id: string,
    @Body() body: FollowingVisibilityDto,
  ) {
    if (!isUuid(id)) throw AppException.validation('Invalid identity id.');
    return this.profiles.setFollowingCountVisible(token, id, body.visible);
  }

  @Get(':id')
  getById(@AccessToken() token: string, @Param('id') id: string) {
    if (!isUuid(id)) throw AppException.validation('Invalid profile id.');
    return this.profiles.card(token, id);
  }
}

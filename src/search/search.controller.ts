import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { SearchService } from './search.service';
import { ActiveProfileGuard } from '../auth/guards/active-profile.guard';
import {
  AccessToken,
  ActiveProfileId,
} from '../common/decorators/current-user.decorator';
import { AppException } from '../common/errors/app-exception';

function requireQuery(q?: string): string {
  const value = (q ?? '').trim();
  if (!value) throw AppException.validation('Query param "q" is required.');
  return value;
}

/** Empty/whitespace query params normalise to undefined (no filter). */
function nz(v?: string): string | undefined {
  const t = (v ?? '').trim();
  return t.length > 0 ? t : undefined;
}

function toLimit(v?: string): number | undefined {
  const t = (v ?? '').trim();
  if (!t) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * `/api/v1/search`. `q` is the text query (optional for profiles/teams, which
 * then browse with filters); `limit` optional. Profile/team search accepts the
 * same filters the app's Search screen offers (game, sub-role, account role,
 * availability, verified, recruiting) plus `order` for browse. Post search
 * hydrates for the active profile (viewer reaction/saved), so it needs the
 * active-profile guard; the class-level guard also validates the header the app
 * always sends.
 *
 * Profile and team search resolve the active profile for the same reason: the
 * ranked path is per-viewer (identity affinity comes from the viewer's own
 * feature model), and `ActiveProfileGuard` establishes the viewer id without
 * ever trusting a client-supplied one.
 */
@Controller('search')
@UseGuards(ActiveProfileGuard)
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get('profiles')
  profiles(
    @AccessToken() token: string,
    @ActiveProfileId() me: string,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
    @Query('game') game?: string,
    @Query('gameRole') gameRole?: string,
    @Query('role') role?: string,
    @Query('availability') availability?: string,
    @Query('verified') verified?: string,
    @Query('order') order?: string,
  ) {
    return this.search.profiles(token, me, {
      q: nz(q),
      limit: toLimit(limit),
      gameId: nz(game),
      gameRoleSlug: nz(gameRole),
      roleId: nz(role),
      availability: nz(availability),
      verifiedOnly: verified === 'true',
      order: nz(order),
    });
  }

  @Get('teams')
  teams(
    @AccessToken() token: string,
    @ActiveProfileId() me: string,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
    @Query('game') game?: string,
    @Query('category') category?: string,
    @Query('recruiting') recruiting?: string,
    @Query('verified') verified?: string,
    @Query('order') order?: string,
  ) {
    return this.search.teams(token, me, {
      q: nz(q),
      limit: toLimit(limit),
      gameId: nz(game),
      categoryId: nz(category),
      recruitingOnly: recruiting === 'true',
      verifiedOnly: verified === 'true',
      order: nz(order),
    });
  }

  @Get('posts')
  posts(
    @AccessToken() token: string,
    @ActiveProfileId() me: string,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
  ) {
    return this.search.postsSearch(token, me, requireQuery(q), toLimit(limit));
  }
}

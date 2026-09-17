import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { SponsorshipsService } from './sponsorships.service';
import { ActiveProfileGuard } from '../auth/guards/active-profile.guard';
import {
  AccessToken,
  ActiveProfileId,
} from '../common/decorators/current-user.decorator';
import { AppException } from '../common/errors/app-exception';
import { isUuid } from '../common/utils/uuid';

/**
 * `/api/v1/sponsorships`. The relationship an approved sponsorship produces.
 *
 * No create route: a sponsorship is created by accepting the sponsorship
 * application that asked for it, and `sponsorships` has no INSERT policy, so this
 * is a read plus one end action. Ending is authorised inside `end_sponsorship`.
 */
@Controller('sponsorships')
@UseGuards(ActiveProfileGuard)
export class SponsorshipsController {
  constructor(private readonly sponsorships: SponsorshipsService) {}

  /**
   * Sponsorships either side of `identity_id`, defaulting to the active profile.
   * Public data, so any signed-in caller may read another profile's.
   */
  @Get()
  list(
    @AccessToken() token: string,
    @ActiveProfileId() me: string,
    @Query('identity_id') identityId?: string,
    @Query('include_ended') includeEnded?: string,
  ) {
    const target = identityId && isUuid(identityId) ? identityId : me;
    return this.sponsorships.list(token, target, includeEnded === 'true');
  }

  @Post(':id/end')
  end(@AccessToken() token: string, @Param('id') id: string) {
    if (!isUuid(id)) {
      throw AppException.badRequest('A sponsorship id must be a UUID.');
    }
    return this.sponsorships.end(token, id);
  }
}

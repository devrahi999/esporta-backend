import { Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { FollowsService } from './follows.service';
import { ActiveProfileGuard } from '../auth/guards/active-profile.guard';
import {
  AccessToken,
  ActiveProfileId,
} from '../common/decorators/current-user.decorator';
import { AppException } from '../common/errors/app-exception';
import { isUuid } from '../common/utils/uuid';

/**
 * `/api/v1/follows`. The follower is always the resolved active profile, so a
 * team can follow/unfollow as itself when its owner/admin is acting for it.
 */
@Controller('follows')
@UseGuards(ActiveProfileGuard)
export class FollowsController {
  constructor(private readonly follows: FollowsService) {}

  @Get('ids')
  myFollowing(@AccessToken() token: string, @ActiveProfileId() me: string) {
    return this.follows.myFollowingIds(token, me);
  }

  @Post(':identityId')
  follow(@AccessToken() token: string, @ActiveProfileId() me: string, @Param('identityId') id: string) {
    if (!isUuid(id)) throw AppException.validation('Invalid identity id.');
    return this.follows.follow(token, me, id);
  }

  @Delete(':identityId')
  unfollow(@AccessToken() token: string, @ActiveProfileId() me: string, @Param('identityId') id: string) {
    if (!isUuid(id)) throw AppException.validation('Invalid identity id.');
    return this.follows.unfollow(token, me, id);
  }

  @Get(':identityId/followers')
  followers(@AccessToken() token: string, @Param('identityId') id: string) {
    if (!isUuid(id)) throw AppException.validation('Invalid identity id.');
    return this.follows.followers(token, id);
  }

  @Get(':identityId/following')
  following(@AccessToken() token: string, @Param('identityId') id: string) {
    if (!isUuid(id)) throw AppException.validation('Invalid identity id.');
    return this.follows.following(token, id);
  }
}

import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ReactionsService } from './reactions.service';
import { ReactDto, ReactorsQueryDto } from './dto/reaction.dto';
import { ActiveProfileGuard } from '../auth/guards/active-profile.guard';
import {
  AccessToken,
  ActiveProfileId,
} from '../common/decorators/current-user.decorator';
import { AppException } from '../common/errors/app-exception';
import { isUuid } from '../common/utils/uuid';

/**
 * Reaction endpoints for posts and comments (plan §19). Writes act as the
 * resolved active profile; a profile has at most one reaction per target.
 */
@Controller()
@UseGuards(ActiveProfileGuard)
export class ReactionsController {
  constructor(private readonly reactions: ReactionsService) {}

  @Post('posts/:id/reaction')
  reactPost(
    @AccessToken() token: string,
    @ActiveProfileId() me: string,
    @Param('id') id: string,
    @Body() dto: ReactDto,
  ) {
    if (!isUuid(id)) throw AppException.validation('Invalid post id.');
    return this.reactions.reactPost(token, me, id, dto.type_id);
  }

  @Delete('posts/:id/reaction')
  unreactPost(@AccessToken() token: string, @ActiveProfileId() me: string, @Param('id') id: string) {
    if (!isUuid(id)) throw AppException.validation('Invalid post id.');
    return this.reactions.unreactPost(token, me, id);
  }

  @Get('posts/:id/reactions')
  postReactions(@AccessToken() token: string, @Param('id') id: string, @Query() q: ReactorsQueryDto) {
    if (!isUuid(id)) throw AppException.validation('Invalid post id.');
    return this.reactions.listPostReactions(token, id, q.type, q.limit, q.offset ?? 0);
  }

  @Post('comments/:id/reaction')
  reactComment(
    @AccessToken() token: string,
    @ActiveProfileId() me: string,
    @Param('id') id: string,
    @Body() dto: ReactDto,
  ) {
    if (!isUuid(id)) throw AppException.validation('Invalid comment id.');
    return this.reactions.reactComment(token, me, id, dto.type_id);
  }

  @Delete('comments/:id/reaction')
  unreactComment(@AccessToken() token: string, @ActiveProfileId() me: string, @Param('id') id: string) {
    if (!isUuid(id)) throw AppException.validation('Invalid comment id.');
    return this.reactions.unreactComment(token, me, id);
  }

  @Get('comments/:id/reactions')
  commentReactions(@AccessToken() token: string, @Param('id') id: string, @Query() q: ReactorsQueryDto) {
    if (!isUuid(id)) throw AppException.validation('Invalid comment id.');
    return this.reactions.listCommentReactions(token, id, q.type, q.limit, q.offset ?? 0);
  }
}

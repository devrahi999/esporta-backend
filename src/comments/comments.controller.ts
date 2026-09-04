import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { CommentsService } from './comments.service';
import { AddCommentDto, EditCommentDto } from './dto/comment.dto';
import { ActiveProfileGuard } from '../auth/guards/active-profile.guard';
import {
  AccessToken,
  ActiveProfileId,
} from '../common/decorators/current-user.decorator';
import { AppException } from '../common/errors/app-exception';
import { isUuid } from '../common/utils/uuid';

class CommentListQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
}

/**
 * Comment endpoints. Listing/creation is scoped to a post; edit/delete target a
 * comment id. Writes act as the resolved active profile (RLS enforces authorship).
 */
@Controller()
@UseGuards(ActiveProfileGuard)
export class CommentsController {
  constructor(private readonly comments: CommentsService) {}

  @Get('posts/:postId/comments')
  forPost(
    @AccessToken() token: string,
    @ActiveProfileId() me: string,
    @Param('postId') postId: string,
    @Query() q: CommentListQueryDto,
  ) {
    if (!isUuid(postId)) throw AppException.validation('Invalid post id.');
    return this.comments.forPost(token, me, postId, q.limit);
  }

  @Post('posts/:postId/comments')
  add(
    @AccessToken() token: string,
    @ActiveProfileId() me: string,
    @Param('postId') postId: string,
    @Body() dto: AddCommentDto,
  ) {
    if (!isUuid(postId)) throw AppException.validation('Invalid post id.');
    return this.comments.add(token, me, postId, dto.body, dto.parent_id);
  }

  @Patch('comments/:id')
  edit(@AccessToken() token: string, @Param('id') id: string, @Body() dto: EditCommentDto) {
    if (!isUuid(id)) throw AppException.validation('Invalid comment id.');
    return this.comments.edit(token, id, dto.body);
  }

  @Delete('comments/:id')
  remove(@AccessToken() token: string, @Param('id') id: string) {
    if (!isUuid(id)) throw AppException.validation('Invalid comment id.');
    return this.comments.delete(token, id);
  }
}

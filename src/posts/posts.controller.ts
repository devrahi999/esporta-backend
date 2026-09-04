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
import { PostsService } from './posts.service';
import { CreatePostDto, MediaIdsDto, UpdateCaptionDto } from './dto/post.dto';
import { CursorQueryDto } from '../common/dto/pagination.dto';
import { ActiveProfileGuard } from '../auth/guards/active-profile.guard';
import {
  AccessToken,
  ActiveProfileId,
} from '../common/decorators/current-user.decorator';
import { AppException } from '../common/errors/app-exception';
import { isUuid } from '../common/utils/uuid';

/**
 * `/api/v1/posts`. Every route acts as the resolved active profile (person or
 * team), so writes are authored by that identity and reads are hydrated for that
 * viewer.
 */
@Controller('posts')
@UseGuards(ActiveProfileGuard)
export class PostsController {
  constructor(private readonly posts: PostsService) {}

  @Get('feed')
  feed(@AccessToken() token: string, @ActiveProfileId() me: string, @Query() q: CursorQueryDto) {
    return this.posts.feed(token, me, q);
  }

  @Get('shorts')
  shorts(@AccessToken() token: string, @ActiveProfileId() me: string, @Query() q: CursorQueryDto) {
    return this.posts.shorts(token, me, q);
  }

  @Get('saved')
  saved(@AccessToken() token: string, @ActiveProfileId() me: string, @Query() q: CursorQueryDto) {
    return this.posts.saved(token, me, q);
  }

  @Get('author/:authorId')
  byAuthor(
    @AccessToken() token: string,
    @ActiveProfileId() me: string,
    @Param('authorId') authorId: string,
    @Query() q: CursorQueryDto,
  ) {
    if (!isUuid(authorId)) throw AppException.validation('Invalid author id.');
    return this.posts.byAuthor(token, me, authorId, q);
  }

  @Get(':id')
  byId(@AccessToken() token: string, @ActiveProfileId() me: string, @Param('id') id: string) {
    if (!isUuid(id)) throw AppException.validation('Invalid post id.');
    return this.posts.byId(token, me, id);
  }

  @Post()
  create(@AccessToken() token: string, @ActiveProfileId() me: string, @Body() dto: CreatePostDto) {
    return this.posts.create(token, me, dto);
  }

  @Patch(':id')
  updateCaption(
    @AccessToken() token: string,
    @ActiveProfileId() me: string,
    @Param('id') id: string,
    @Body() dto: UpdateCaptionDto,
  ) {
    if (!isUuid(id)) throw AppException.validation('Invalid post id.');
    return this.posts.updateCaption(token, me, id, dto.caption);
  }

  @Delete(':id')
  remove(@AccessToken() token: string, @Param('id') id: string) {
    if (!isUuid(id)) throw AppException.validation('Invalid post id.');
    return this.posts.delete(token, id);
  }

  @Post(':id/media')
  attachMedia(@AccessToken() token: string, @Param('id') id: string, @Body() dto: MediaIdsDto) {
    if (!isUuid(id)) throw AppException.validation('Invalid post id.');
    return this.posts.attachMedia(token, id, dto.media_ids);
  }

  @Patch(':id/media/order')
  orderMedia(@AccessToken() token: string, @Param('id') id: string, @Body() dto: MediaIdsDto) {
    if (!isUuid(id)) throw AppException.validation('Invalid post id.');
    return this.posts.orderMedia(token, dto.media_ids);
  }

  @Post(':id/save')
  save(@AccessToken() token: string, @ActiveProfileId() me: string, @Param('id') id: string) {
    if (!isUuid(id)) throw AppException.validation('Invalid post id.');
    return this.posts.save(token, me, id);
  }

  @Delete(':id/save')
  unsave(@AccessToken() token: string, @ActiveProfileId() me: string, @Param('id') id: string) {
    if (!isUuid(id)) throw AppException.validation('Invalid post id.');
    return this.posts.unsave(token, me, id);
  }
}

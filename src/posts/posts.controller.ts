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
import { PostsService, type PostPage } from './posts.service';
import { CreatePostDto, MediaIdsDto, UpdateCaptionDto } from './dto/post.dto';
import { CursorQueryDto, FeedQueryDto } from '../common/dto/pagination.dto';
import { ActiveProfileGuard } from '../auth/guards/active-profile.guard';
import {
  AccessToken,
  ActiveProfileId,
} from '../common/decorators/current-user.decorator';
import { AppException } from '../common/errors/app-exception';
import { isUuid } from '../common/utils/uuid';
import { enveloped } from '../common/http/api-response';

/**
 * `/api/v1/posts`. Every route acts as the resolved active profile (person or
 * team), so writes are authored by that identity and reads are hydrated for that
 * viewer.
 */
@Controller('posts')
@UseGuards(ActiveProfileGuard)
export class PostsController {
  constructor(private readonly posts: PostsService) {}

  /**
   * The Home feed.
   *
   * BACKWARD-COMPATIBLE BY CONSTRUCTION. `data` is still the bare array of posts
   * every existing client expects; the ranked cursor and the algorithm version
   * ride in `meta`, which an older client ignores. So the same response serves an
   * un-updated app (keeps paging by `before=created_at`) and an updated one
   * (pages by `meta.cursor` and gets stable ranked pagination).
   *
   * `meta` deliberately carries version and counts only — never a score
   * breakdown. Score components are internal and reachable only through the
   * capability-gated admin surface (§23).
   */
  @Get('feed')
  async feed(
    @AccessToken() token: string,
    @ActiveProfileId() me: string,
    @Query() q: FeedQueryDto,
  ) {
    return feedEnvelope(await this.posts.feed(token, me, q));
  }

  @Get('shorts')
  async shorts(
    @AccessToken() token: string,
    @ActiveProfileId() me: string,
    @Query() q: FeedQueryDto,
  ) {
    return feedEnvelope(await this.posts.shorts(token, me, q));
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

/**
 * Wraps a {@link PostPage} so `data` stays the plain post array and the ranking
 * metadata travels in `meta`.
 *
 * Only non-sensitive fields are surfaced: which surface ran, whether the page was
 * ranked, the algorithm version (needed for traceability and for reproducing a
 * report) and the cursor. Candidate counts, score components and feature values
 * stay server-side.
 */
function feedEnvelope(page: PostPage) {
  return enveloped(page.items, {
    ranked: page.ranked,
    cursor: page.cursor,
    ...(page.meta
      ? {
          surface: page.meta.surface,
          algorithmVersion: page.meta.algorithmVersion,
          configVersionId: page.meta.configVersionId,
        }
      : {}),
  });
}

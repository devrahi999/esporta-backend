import { Body, Controller, Delete, Param, Post, UseGuards } from '@nestjs/common';
import { MediaService } from './media.service';
import {
  CompleteImageUploadDto,
  CompleteReplaceDto,
  CreateImageUploadSessionDto,
  CreateVideoUploadSessionDto,
  ReplaceImageSessionDto,
} from './dto/media.dto';
import { ActiveProfileGuard } from '../auth/guards/active-profile.guard';
import {
  AccessToken,
  ActiveProfileId,
  CurrentUser,
} from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/http/request-context';
import { AppException } from '../common/errors/app-exception';
import { isUuid } from '../common/utils/uuid';

/**
 * `/api/v1/media`. Presigned R2 image flow: request a session, PUT bytes to R2
 * directly, then complete to record metadata. Acts as the resolved active
 * profile, so uploads land under that identity's key prefix.
 */
@Controller('media')
@UseGuards(ActiveProfileGuard)
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Post('images/upload-session')
  createSession(@ActiveProfileId() me: string, @Body() dto: CreateImageUploadSessionDto) {
    return this.media.createImageUploadSession(me, dto);
  }

  @Post('images/complete')
  complete(
    @AccessToken() token: string,
    @CurrentUser() user: AuthenticatedUser,
    @ActiveProfileId() me: string,
    @Body() dto: CompleteImageUploadDto,
  ) {
    return this.media.completeImageUpload(token, user.id, me, dto);
  }

  @Post('videos/upload-session')
  createVideoSession(
    @AccessToken() token: string,
    @CurrentUser() user: AuthenticatedUser,
    @ActiveProfileId() me: string,
    @Body() dto: CreateVideoUploadSessionDto,
  ) {
    return this.media.createVideoUploadSession(token, user.id, me, dto);
  }

  @Post(':mediaId/replace-session')
  replaceSession(
    @AccessToken() token: string,
    @ActiveProfileId() me: string,
    @Param('mediaId') mediaId: string,
    @Body() dto: ReplaceImageSessionDto,
  ) {
    this.assert(mediaId);
    return this.media.replaceSession(token, me, mediaId, dto);
  }

  @Post(':mediaId/replace-complete')
  replaceComplete(
    @AccessToken() token: string,
    @ActiveProfileId() me: string,
    @Param('mediaId') mediaId: string,
    @Body() dto: CompleteReplaceDto,
  ) {
    this.assert(mediaId);
    return this.media.completeReplace(token, me, mediaId, dto);
  }

  @Delete(':mediaId')
  remove(@AccessToken() token: string, @Param('mediaId') mediaId: string) {
    this.assert(mediaId);
    return this.media.delete(token, mediaId);
  }

  private assert(mediaId: string): void {
    if (!isUuid(mediaId)) throw AppException.validation('Invalid media id.');
  }
}

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
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { NotificationsService } from './notifications.service';
import { MarkReadDto } from './dto/notification.dto';
import { ActiveProfileGuard } from '../auth/guards/active-profile.guard';
import {
  AccessToken,
  ActiveProfileId,
} from '../common/decorators/current-user.decorator';
import { AppException } from '../common/errors/app-exception';
import { isUuid } from '../common/utils/uuid';

class NotificationQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

/**
 * `/api/v1/notifications`. Scoped to the active inbox. Reads, unread count,
 * mark-read (explicit ids or all), and dismiss.
 */
@Controller('notifications')
@UseGuards(ActiveProfileGuard)
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@AccessToken() token: string, @ActiveProfileId() inbox: string, @Query() q: NotificationQueryDto) {
    return this.notifications.list(token, inbox, q.limit);
  }

  @Get('unread-count')
  unreadCount(@AccessToken() token: string, @ActiveProfileId() inbox: string) {
    return this.notifications.unreadCount(token, inbox);
  }

  @Post('read')
  markRead(@AccessToken() token: string, @Body() dto: MarkReadDto) {
    return this.notifications.markRead(token, dto.ids);
  }

  @Post('read-all')
  markAll(@AccessToken() token: string, @ActiveProfileId() inbox: string) {
    return this.notifications.markAll(token, inbox);
  }

  @Delete(':id')
  dismiss(@AccessToken() token: string, @Param('id') id: string) {
    if (!isUuid(id)) throw AppException.validation('Invalid notification id.');
    return this.notifications.dismiss(token, id);
  }
}

import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApplicationsService } from './applications.service';
import {
  AcceptApplicationDto,
  ApplicationQueryDto,
  CreateApplicationDto,
  HideApplicationsDto,
  MarkMessagesReadDto,
  RejectApplicationDto,
  RespondApplicationDto,
  SendMessageDto,
} from './dto/application.dto';
import { ActiveProfileGuard } from '../auth/guards/active-profile.guard';
import {
  AccessToken,
  ActiveProfileId,
} from '../common/decorators/current-user.decorator';
import { AppException } from '../common/errors/app-exception';
import { isUuid } from '../common/utils/uuid';

/**
 * `/api/v1/applications`. Acts as the resolved active profile (applicant/sender);
 * reads are RLS-scoped. Accept is privileged; reject/advance are guarded updates.
 */
@Controller('applications')
@UseGuards(ActiveProfileGuard)
export class ApplicationsController {
  constructor(private readonly applications: ApplicationsService) {}

  /**
   * The caller's queue. `?kind=`, `?status=` and `?role=` narrow the query, not
   * the response — a client filter chip maps to fewer rows over the wire.
   */
  @Get()
  list(@AccessToken() token: string, @Query() query: ApplicationQueryDto) {
    return this.applications.list(token, query);
  }

  @Post()
  create(@AccessToken() token: string, @ActiveProfileId() me: string, @Body() dto: CreateApplicationDto) {
    return this.applications.create(token, me, dto);
  }

  /**
   * Removes rows from the caller's own list. Not a status change, not a delete —
   * the counterparty's copy, the thread and every counter stay as they were.
   *
   * Declared before `:id/...` for readability only; it cannot collide with them,
   * since those carry a second path segment.
   */
  @Post('hide')
  hide(@AccessToken() token: string, @Body() dto: HideApplicationsDto) {
    return this.applications.hide(token, dto.ids);
  }

  @Get(':id')
  getById(@AccessToken() token: string, @Param('id') id: string) {
    this.assert(id);
    return this.applications.getById(token, id);
  }

  @Post(':id/accept')
  accept(@AccessToken() token: string, @Param('id') id: string, @Body() dto: AcceptApplicationDto) {
    this.assert(id);
    return this.applications.accept(token, id, dto.note, dto.add_to_roster);
  }

  @Post(':id/reject')
  reject(@AccessToken() token: string, @Param('id') id: string, @Body() dto: RejectApplicationDto) {
    this.assert(id);
    return this.applications.respond(token, id, 'rejected', dto.note);
  }

  @Patch(':id/status')
  respond(@AccessToken() token: string, @Param('id') id: string, @Body() dto: RespondApplicationDto) {
    this.assert(id);
    return this.applications.respond(token, id, dto.status, dto.note);
  }

  @Get(':id/messages')
  messages(@AccessToken() token: string, @Param('id') id: string) {
    this.assert(id);
    return this.applications.messages(token, id);
  }

  @Post(':id/messages')
  send(
    @AccessToken() token: string,
    @ActiveProfileId() me: string,
    @Param('id') id: string,
    @Body() dto: SendMessageDto,
  ) {
    this.assert(id);
    return this.applications.sendMessage(token, me, id, dto.kind, dto.message);
  }

  @Post(':id/messages/read')
  markRead(@AccessToken() token: string, @Param('id') id: string, @Body() dto: MarkMessagesReadDto) {
    this.assert(id);
    return this.applications.markMessagesRead(token, dto.ids);
  }

  private assert(id: string): void {
    if (!isUuid(id)) throw AppException.validation('Invalid application id.');
  }
}

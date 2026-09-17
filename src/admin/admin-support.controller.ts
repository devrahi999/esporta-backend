import { Body, Controller, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { AdminService } from './admin.service';
import { AdminGuard } from './guards/admin.guard';
import { AccessToken } from '../common/decorators/current-user.decorator';
import { AppException } from '../common/errors/app-exception';
import { isUuid } from '../common/utils/uuid';
import {
  AdminSupportQuery,
  ReorderFaqDto,
  ReorderReferenceDto,
  ReplyTicketDto,
  SetFaqActiveDto,
  SetReferenceActiveDto,
  SetTicketStatusDto,
  UpsertFaqDto,
  UpsertReferenceDto,
} from './dto/admin.dto';

function uuid(id: string, label = 'id'): void {
  if (!isUuid(id)) throw AppException.validation(`Invalid ${label}.`);
}

/**
 * `/api/v1/admin` — support tickets, FAQ management, and reference-data CRUD.
 */
@Controller('admin')
@UseGuards(AdminGuard)
export class AdminSupportController {
  constructor(private readonly admin: AdminService) {}

  // support
  @Get('support-tickets') tickets(@AccessToken() t: string, @Query() q: AdminSupportQuery) { return this.admin.supportTickets(t, q); }
  @Get('support-tickets/:id') ticketDetail(@AccessToken() t: string, @Param('id') id: string) {
    uuid(id, 'ticket id');
    return this.admin.supportTicketDetail(t, id);
  }
  @Post('support-tickets/:id/reply') reply(@AccessToken() t: string, @Param('id') id: string, @Body() dto: ReplyTicketDto) {
    uuid(id, 'ticket id');
    return this.admin.replyTicket(t, id, dto.body);
  }
  @Post('support-tickets/:id/status') ticketStatus(@AccessToken() t: string, @Param('id') id: string, @Body() dto: SetTicketStatusDto) {
    uuid(id, 'ticket id');
    return this.admin.setTicketStatus(t, id, dto.status, dto.note);
  }

  // faq
  @Get('faqs') faqs(@AccessToken() t: string) { return this.admin.faqs(t); }
  @Post('faqs') upsertFaq(@AccessToken() t: string, @Body() dto: UpsertFaqDto) { return this.admin.upsertFaq(t, dto); }
  @Post('faqs/reorder') reorderFaq(@AccessToken() t: string, @Body() dto: ReorderFaqDto) { return this.admin.reorderFaq(t, dto); }
  @Put('faqs/:id/active') faqActive(@AccessToken() t: string, @Param('id') id: string, @Body() dto: SetFaqActiveDto) {
    uuid(id, 'faq id');
    return this.admin.setFaqActive(t, id, dto.active, dto.note);
  }

  // reference data
  @Post('reference') upsertReference(@AccessToken() t: string, @Body() dto: UpsertReferenceDto) { return this.admin.upsertReference(t, dto); }
  @Post('reference/reorder') reorderReference(@AccessToken() t: string, @Body() dto: ReorderReferenceDto) { return this.admin.reorderReference(t, dto); }
  @Put('reference/active') referenceActive(@AccessToken() t: string, @Body() dto: SetReferenceActiveDto) {
    return this.admin.setReferenceActive(t, dto.kind, dto.id, dto.active, dto.note);
  }
}

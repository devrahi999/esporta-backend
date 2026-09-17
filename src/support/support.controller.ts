import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { SupportService } from './support.service';
import { AccessToken, CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/http/request-context';
import { IsString, MaxLength } from 'class-validator';
import { AppException } from '../common/errors/app-exception';
import { isUuid } from '../common/utils/uuid';

export class SubmitTicketDto {
  @IsString() @MaxLength(100) subject!: string;
  @IsString() @MaxLength(50) reason!: string;
  @IsString() @MaxLength(1000) description!: string;
}

@Controller('support')
export class SupportController {
  constructor(private readonly support: SupportService) {}

  @Get('faqs')
  faqs(@AccessToken() token: string) {
    return this.support.faqs(token);
  }

  @Get('tickets')
  myTickets(@AccessToken() token: string, @CurrentUser() user: AuthenticatedUser) {
    return this.support.myTickets(token, user.id);
  }

  @Get('tickets/:id')
  async ticket(@AccessToken() token: string, @Param('id') id: string) {
    if (!isUuid(id)) throw AppException.validation('Invalid ticket id.');
    const t = await this.support.ticket(token, id);
    if (!t) throw AppException.notFound('Ticket not found.');
    return t;
  }

  @Get('tickets/:id/messages')
  messages(@AccessToken() token: string, @Param('id') id: string) {
    if (!isUuid(id)) throw AppException.validation('Invalid ticket id.');
    return this.support.messages(token, id);
  }

  @Post('tickets')
  async submitTicket(@AccessToken() token: string, @Body() dto: SubmitTicketDto) {
    const id = await this.support.submitTicket(token, dto.subject, dto.reason, dto.description);
    return { id };
  }
}

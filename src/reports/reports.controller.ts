import { Body, Controller, Post } from '@nestjs/common';
import { ReportsService } from './reports.service';
import { AccessToken, CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/http/request-context';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class SubmitReportDto {
  @IsIn(['post', 'comment', 'identity']) surface!: string;
  @IsUUID() targetId!: string;
  @IsString() @MaxLength(50) reasonId!: string;
  @IsOptional() @IsString() @MaxLength(1000) details?: string;
}

@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Post()
  submit(@AccessToken() token: string, @CurrentUser() user: AuthenticatedUser, @Body() dto: SubmitReportDto) {
    return this.reports.submit(token, user.id, dto.surface, dto.targetId, dto.reasonId, dto.details);
  }
}

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
import { RecruitmentService } from './recruitment.service';
import {
  CreateRecruitmentDto,
  RecruitmentQueryDto,
  SetRecruitmentStatusDto,
} from './dto/recruitment.dto';
import { ActiveProfileGuard } from '../auth/guards/active-profile.guard';
import {
  AccessToken,
  ActiveProfileId,
} from '../common/decorators/current-user.decorator';
import { AppException } from '../common/errors/app-exception';
import { isUuid } from '../common/utils/uuid';

/**
 * `/api/v1/recruitments`. Openings owned by the acting identity. List defaults to
 * the active profile's own openings when `owner_id` is omitted.
 */
@Controller('recruitments')
@UseGuards(ActiveProfileGuard)
export class RecruitmentController {
  constructor(private readonly recruitment: RecruitmentService) {}

  @Get()
  list(@AccessToken() token: string, @ActiveProfileId() me: string, @Query() q: RecruitmentQueryDto) {
    return this.recruitment.list(token, q.owner_id ?? me, q.status);
  }

  @Post()
  create(@AccessToken() token: string, @ActiveProfileId() me: string, @Body() dto: CreateRecruitmentDto) {
    return this.recruitment.create(token, me, dto);
  }

  @Get(':id')
  getById(@AccessToken() token: string, @Param('id') id: string) {
    if (!isUuid(id)) throw AppException.validation('Invalid recruitment id.');
    return this.recruitment.getById(token, id);
  }

  @Patch(':id/status')
  setStatus(@AccessToken() token: string, @Param('id') id: string, @Body() dto: SetRecruitmentStatusDto) {
    if (!isUuid(id)) throw AppException.validation('Invalid recruitment id.');
    return this.recruitment.setStatus(token, id, dto.status);
  }

  @Post(':id/close')
  close(@AccessToken() token: string, @Param('id') id: string) {
    if (!isUuid(id)) throw AppException.validation('Invalid recruitment id.');
    return this.recruitment.setStatus(token, id, 'closed');
  }
}

import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { TryoutsService } from './tryouts.service';
import { CreateTryoutDto, UpdateTryoutStatusDto } from './dto/tryout.dto';
import { AccessToken } from '../common/decorators/current-user.decorator';
import { AppException } from '../common/errors/app-exception';
import { isUuid } from '../common/utils/uuid';

/**
 * Tryout endpoints. Scheduling is scoped to an application; status/notify target
 * a tryout id. Authorisation is enforced by RLS + the tryout guards
 * (recruiting side only), so only a valid JWT is required.
 */
@Controller()
export class TryoutsController {
  constructor(private readonly tryouts: TryoutsService) {}

  @Get('applications/:applicationId/tryouts')
  list(@AccessToken() token: string, @Param('applicationId') applicationId: string) {
    if (!isUuid(applicationId)) throw AppException.validation('Invalid application id.');
    return this.tryouts.listForApplication(token, applicationId);
  }

  @Post('applications/:applicationId/tryouts')
  create(
    @AccessToken() token: string,
    @Param('applicationId') applicationId: string,
    @Body() dto: CreateTryoutDto,
  ) {
    if (!isUuid(applicationId)) throw AppException.validation('Invalid application id.');
    return this.tryouts.create(token, applicationId, dto);
  }

  @Patch('tryouts/:id/status')
  setStatus(@AccessToken() token: string, @Param('id') id: string, @Body() dto: UpdateTryoutStatusDto) {
    if (!isUuid(id)) throw AppException.validation('Invalid tryout id.');
    return this.tryouts.setStatus(token, id, dto.status);
  }

  @Post('tryouts/:id/notify')
  notify(@AccessToken() token: string, @Param('id') id: string) {
    if (!isUuid(id)) throw AppException.validation('Invalid tryout id.');
    return this.tryouts.notify(token, id);
  }
}

import { Body, Controller, Patch, Post } from '@nestjs/common';
import { PushService } from './push.service';
import {
  DeactivateDeviceDto,
  RegisterDeviceDto,
  SetDeviceProfileDto,
} from './dto/push.dto';
import { AccessToken } from '../common/decorators/current-user.decorator';

/**
 * `/api/v1/push/devices`. Device registration is per-user (personal); the active
 * profile is carried in the body, so no active-profile header is required.
 */
@Controller('push/devices')
export class PushController {
  constructor(private readonly push: PushService) {}

  @Post()
  register(@AccessToken() token: string, @Body() dto: RegisterDeviceDto) {
    return this.push.register(token, dto);
  }

  @Patch('profile')
  setProfile(@AccessToken() token: string, @Body() dto: SetDeviceProfileDto) {
    return this.push.setProfile(token, dto.device_id, dto.active_profile_id);
  }

  @Post('deactivate')
  deactivate(@AccessToken() token: string, @Body() dto: DeactivateDeviceDto) {
    return this.push.deactivate(token, dto.device_id);
  }
}

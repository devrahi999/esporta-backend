import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import type { RegisterDeviceDto } from './dto/push.dto';

/**
 * Push-device registration. A device belongs to the signed-in user; the
 * `active_profile_id` records which profile the device currently shows so push
 * routing (server-side) only delivers a profile's notifications to devices
 * switched to it. FCM sending itself stays server-side (Phase 7).
 */
@Injectable()
export class PushService {
  constructor(private readonly supabase: SupabaseService) {}

  async register(token: string, dto: RegisterDeviceDto): Promise<{ id: string }> {
    const id = await this.supabase.rpcAsCaller<string>(token, 'register_push_device', {
      p_device_id: dto.device_id,
      p_token: dto.token,
      p_platform: dto.platform,
      p_active_profile_id: dto.active_profile_id ?? null,
    });
    return { id };
  }

  async setProfile(token: string, deviceId: string, profileId?: string): Promise<{ ok: true }> {
    await this.supabase.rpcAsCaller(token, 'set_push_device_profile', {
      p_device_id: deviceId,
      p_active_profile_id: profileId ?? null,
    });
    return { ok: true };
  }

  async deactivate(token: string, deviceId: string): Promise<{ ok: true }> {
    await this.supabase.rpcAsCaller(token, 'deactivate_push_device', { p_device_id: deviceId });
    return { ok: true };
  }
}

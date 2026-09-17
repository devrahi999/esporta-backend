import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export const PUSH_PLATFORMS = ['android', 'ios'] as const;

export class RegisterDeviceDto {
  @IsString() @MaxLength(128) device_id!: string;
  @IsString() @MaxLength(512) token!: string;
  @IsIn(PUSH_PLATFORMS) platform!: string;
  @IsOptional() @IsUUID('4') active_profile_id?: string;
}

export class SetDeviceProfileDto {
  @IsString() @MaxLength(128) device_id!: string;
  @IsOptional() @IsUUID('4') active_profile_id?: string;
}

export class DeactivateDeviceDto {
  @IsString() @MaxLength(128) device_id!: string;
}

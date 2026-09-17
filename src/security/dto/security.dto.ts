import { IsBoolean, IsEmail, IsIn, IsString, MaxLength, MinLength } from 'class-validator';

export class SetRecoveryEmailDto {
  @IsEmail() @MaxLength(254) email!: string;
}

export class CodeDto {
  @IsString() @MinLength(4) @MaxLength(12) code!: string;
}

export class EnabledDto {
  @IsBoolean() enabled!: boolean;
}

export class SetTwoStepDto {
  // Tightly enumerated: the value flows into a security RPC, and a whitelist
  // here means an arbitrary string can never reach the DB layer.
  @IsIn(['email', 'totp']) method!: string;
  @IsBoolean() enabled!: boolean;
}

export class PasswordDto {
  @IsString() @MinLength(1) @MaxLength(256) password!: string;
}

export class BeginLoginDto {
  @IsString() @MaxLength(128) device_id!: string;
  @IsString() @MaxLength(200) device_name!: string;
  @IsString() @MaxLength(40) platform!: string;
  @IsString() @MaxLength(40) app_version!: string;
}

export class DecideLoginApprovalDto {
  @IsBoolean() approve!: boolean;
}

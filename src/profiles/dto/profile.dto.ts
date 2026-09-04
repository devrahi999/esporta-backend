import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import {
  ProfileLinkDto,
  RoleDetailsDto,
} from '../../common/dto/role-profile.dto';

export const AVAILABILITY = ['looking_for_team', 'in_team', 'unavailable'] as const;

/**
 * Partial patch for `save_profile` (personal identity only). Only present keys
 * are written server-side. Mirrors the keys the app's edit screen sends.
 */
export class SaveProfileDto {
  @IsOptional() @IsString() @MaxLength(80) name?: string;
  @IsOptional() @IsString() @MaxLength(30) username?: string;
  @IsOptional() @IsString() avatar_url?: string;
  @IsOptional() @IsString() cover_url?: string;
  @IsOptional() @IsString() @MaxLength(500) bio?: string;
  @IsOptional() @IsString() @MaxLength(100) short_bio?: string;
  @IsOptional() @IsString() @MaxLength(80) country?: string;
  @IsOptional() @IsString() @MaxLength(80) city?: string;
  @IsOptional() @IsString() primary_role_id?: string;
  @IsOptional() @IsIn(AVAILABILITY) availability?: string;
  @IsOptional() @IsObject() socials?: Record<string, string>;
  @IsOptional() @IsArray() @IsString({ each: true }) languages?: string[];

  // The last thing the setup wizard writes, and the flag `main.dart` reads to
  // decide whether to show the app or the wizard. `save_profile` has always
  // accepted it; this DTO did not, so `forbidNonWhitelisted` rejected the
  // wizard's final PATCH with a 400 and the app reported it as a connection
  // problem. Every field the user had filled in was lost with it.
  @IsOptional() @IsBoolean() setup_completed?: boolean;

  // Role-specific data (Coach, Manager, Analyst, Creator, Caster). Forwarded by
  // `save_profile` to `apply_identity_role_patch`; absent keys are left alone,
  // so an edit screen that touches only the common fields cannot blank them.
  @IsOptional() @ValidateNested() @Type(() => RoleDetailsDto) role_details?: RoleDetailsDto;
  @IsOptional() @IsObject() role_tags?: Record<string, string[]>;
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProfileLinkDto)
  links?: ProfileLinkDto[];
}

export class UserGameDto {
  @IsString() game_id!: string;
  @IsString() ign!: string;
  @IsOptional() @IsString() game_uid?: string;
  @IsOptional() @IsString() role?: string;
  @IsOptional() @IsString() rank?: string;
  @IsOptional() @IsBoolean() is_primary?: boolean;
}

export class ReplaceGamesDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UserGameDto)
  games!: UserGameDto[];
}

/**
 * `PUT /profiles/:id/following-visibility`.
 *
 * A required boolean rather than an optional one: this route sets a preference,
 * and an absent value would have to mean either "leave it" — a no-op that reports
 * success — or "false", which turns a malformed body into a privacy change.
 * Neither is acceptable for a privacy switch.
 */
export class FollowingVisibilityDto {
  @IsBoolean() visible!: boolean;
}

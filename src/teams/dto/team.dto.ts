import { Type } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  ProfileLinkDto,
  RoleDetailsDto,
} from '../../common/dto/role-profile.dto';

export class AchievementDto {
  @IsString() @MinLength(1) @MaxLength(120) title!: string;
  @IsOptional() @IsString() @MaxLength(60) placement?: string;
  @IsOptional() @IsInt() year?: number;
}

export class CreateTeamDto {
  @IsString() @MinLength(2) @MaxLength(30) username!: string;
  @IsString() @MinLength(1) @MaxLength(80) name!: string;
  @IsOptional() @IsString() @MaxLength(10) tag?: string;
  @IsOptional() @IsString() primary_game_id?: string;
  @IsOptional() @IsString() region?: string;
  @IsOptional() @IsString() @MaxLength(500) bio?: string;
  @IsOptional() @IsString() @MaxLength(100) short_bio?: string;
  @IsOptional() @IsString() country?: string;
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsString() category_id?: string;
  @IsOptional() @IsString() avatar_url?: string;
  @IsOptional() @IsString() banner_url?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) games?: string[];
  @IsOptional() @IsObject() socials?: Record<string, string>;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => AchievementDto) achievements?: AchievementDto[];
  @IsOptional() @IsString() founded?: string;
}

export class SaveTeamProfileDto {
  @IsOptional() @IsString() @MaxLength(30) username?: string;
  @IsOptional() @IsString() @MaxLength(80) name?: string;
  @IsOptional() @IsString() avatar_url?: string;
  @IsOptional() @IsString() cover_url?: string;
  @IsOptional() @IsString() @MaxLength(500) bio?: string;
  @IsOptional() @IsString() @MaxLength(100) short_bio?: string;
  @IsOptional() @IsString() country?: string;
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsString() @MaxLength(10) tag?: string;
  @IsOptional() @IsString() primary_game_id?: string;
  @IsOptional() @IsString() region?: string;
  @IsOptional() @IsString() category_id?: string;
  @IsOptional() @IsString() recruiting?: string;
  @IsOptional() @IsObject() socials?: Record<string, string>;
  @IsOptional() @IsArray() @IsString({ each: true }) games?: string[];
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => AchievementDto) achievements?: AchievementDto[];
  @IsOptional() @IsString() founded?: string;

  // Role-specific data for the other-profile types (News / Media, Tournament
  // Organizer). Forwarded by `save_team_profile` to `apply_identity_role_patch`.
  @IsOptional() @ValidateNested() @Type(() => RoleDetailsDto) role_details?: RoleDetailsDto;
  @IsOptional() @IsObject() role_tags?: Record<string, string[]>;
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProfileLinkDto)
  links?: ProfileLinkDto[];
}

export class SaveTeamAchievementsDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => AchievementDto) achievements!: AchievementDto[];
}

export class InviteMemberDto {
  @IsUUID('4') identity_id!: string;
  @IsOptional() @IsString() role?: string;
  @IsOptional() @IsString() game_role_slug?: string;
}

export class SetMemberRoleDto {
  @IsString() role!: string;
}

export class TransferOwnerDto {
  @IsUUID('4') new_owner!: string;
}

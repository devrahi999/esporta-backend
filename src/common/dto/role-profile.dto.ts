import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

/**
 * Role-specific profile data, shared by the personal-profile and team-profile
 * patches.
 *
 * Both `save_profile` and `save_team_profile` forward these three keys to
 * `apply_identity_role_patch`, which is where the real sanitising happens
 * (URL scheme, list ceilings, tag/label lengths). The DTO exists because the
 * global `ValidationPipe` runs with `forbidNonWhitelisted`, so a key with no
 * declaration here would be rejected with a 400 before it ever reached the RPC.
 */

export const LINK_KINDS = ['platform', 'portfolio', 'website'] as const;

/** One external link with a display label. The URL is opened, never printed. */
export class ProfileLinkDto {
  @IsIn(LINK_KINDS) kind!: string;
  @IsOptional() @IsString() @MaxLength(40) platform?: string;
  @IsString() @MinLength(1) @MaxLength(80) label!: string;
  @IsString() @MinLength(4) @MaxLength(500) url!: string;
  @IsOptional() @IsInt() @Min(0) @Max(100) sort_order?: number;
}

/** The scalar half, plus the narrative fields that are read rather than filtered. */
export class RoleDetailsDto {
  @IsOptional() @IsString() @MaxLength(80) region?: string;
  @IsOptional() @IsInt() @Min(0) @Max(60) experience_years?: number;
  @IsOptional() @IsString() @MaxLength(120) current_affiliation?: string;
  @IsOptional() @IsObject() details?: Record<string, unknown>;
}

/**
 * The three optional keys any identity patch may carry. Mixed into
 * `SaveProfileDto` and `SaveTeamProfileDto` by declaration rather than
 * inheritance, because both already extend nothing and class-validator reads
 * decorators off the concrete class.
 */
export class RoleProfilePatchDto {
  @IsOptional() @ValidateNested() @Type(() => RoleDetailsDto) role_details?: RoleDetailsDto;

  /**
   * Group → selected values, e.g. `{ coaching_type: ['head_coach'] }`. Left as a
   * plain object: the groups are open-ended by design (a new facet is a new key,
   * not a migration) and the RPC caps both the key and the value lengths.
   */
  @IsOptional() @IsObject() role_tags?: Record<string, string[]>;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProfileLinkDto)
  links?: ProfileLinkDto[];
}

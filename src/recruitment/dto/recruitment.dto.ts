import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export const RECRUITMENT_SETTABLE_STATUS = ['open', 'closed'] as const;

export class CreateRecruitmentDto {
  @IsUUID('4') post_id!: string;
  @IsOptional() @IsString() @MaxLength(64) game_id?: string;
  @IsOptional() @IsString() @MaxLength(64) role_id?: string;
  @IsOptional() @IsString() @MaxLength(64) game_role_slug?: string;
  @IsOptional() @IsString() @MaxLength(8) region?: string;
  @IsOptional() @IsString() @MaxLength(56) country?: string;
  @IsOptional() @IsString() @MaxLength(120) city?: string;
  @IsOptional() @Type(() => Number) @IsInt() min_rank_tier?: number;
  @IsOptional() @Type(() => Number) @IsInt() max_rank_tier?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(120) min_age?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(120) max_age?: number;
  @IsOptional() @IsString() @MaxLength(200) availability?: string;
  @IsOptional() @IsString() @MaxLength(2000) requirements?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) slots?: number;
  @IsOptional() @IsISO8601() deadline?: string;
}

export class SetRecruitmentStatusDto {
  @IsIn(RECRUITMENT_SETTABLE_STATUS) status!: string;
}

export class RecruitmentQueryDto {
  @IsOptional() @IsUUID('4') owner_id?: string;
  @IsOptional() @IsString() status?: string;
}

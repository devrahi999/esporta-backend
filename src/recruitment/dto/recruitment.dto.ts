import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export const RECRUITMENT_SETTABLE_STATUS = ['open', 'closed'] as const;

export class CreateRecruitmentDto {
  @IsUUID('4') post_id!: string;
  @IsOptional() @IsString() game_id?: string;
  @IsOptional() @IsString() role_id?: string;
  @IsOptional() @IsString() game_role_slug?: string;
  @IsOptional() @IsString() region?: string;
  @IsOptional() @IsString() country?: string;
  @IsOptional() @IsString() city?: string;
  @IsOptional() @Type(() => Number) @IsInt() min_rank_tier?: number;
  @IsOptional() @Type(() => Number) @IsInt() max_rank_tier?: number;
  @IsOptional() @Type(() => Number) @IsInt() min_age?: number;
  @IsOptional() @Type(() => Number) @IsInt() max_age?: number;
  @IsOptional() @IsString() availability?: string;
  @IsOptional() @IsString() @MaxLength(2000) requirements?: string;
  @IsOptional() @Type(() => Number) @IsInt() slots?: number;
  @IsOptional() @IsISO8601() deadline?: string;
}

export class SetRecruitmentStatusDto {
  @IsIn(RECRUITMENT_SETTABLE_STATUS) status!: string;
}

export class RecruitmentQueryDto {
  @IsOptional() @IsUUID('4') owner_id?: string;
  @IsOptional() @IsString() status?: string;
}

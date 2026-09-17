import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export const TRYOUT_SETTABLE_STATUS = ['completed', 'cancelled'] as const;

export class CreateTryoutDto {
  @IsString() tryout_date!: string; // 'YYYY-MM-DD'
  @IsString() tryout_time!: string; // 'HH:mm' or 'HH:mm:ss'
  @Type(() => Number) @IsInt() @Min(0) matches_count!: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) sessions_count?: number;
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}

export class UpdateTryoutStatusDto {
  @IsIn(TRYOUT_SETTABLE_STATUS) status!: string;
}

import { Type } from 'class-transformer';
import { IsInt, IsISO8601, IsOptional, Max, Min } from 'class-validator';

/**
 * Cursor pagination shared by feeds/lists. The app pages by keyset on
 * `created_at` (`before` = the last row's timestamp), which is stable under
 * inserts — see the feed contract. `limit` is clamped in the service.
 */
export class CursorQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @IsOptional()
  @IsISO8601()
  before?: string;
}

export function clampLimit(limit: number | undefined, fallback: number, max = 50): number {
  if (!limit || Number.isNaN(limit)) return fallback;
  return Math.min(Math.max(1, Math.trunc(limit)), max);
}

import { Type } from 'class-transformer';
import {
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

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

/**
 * The ranked-surface query: {@link CursorQueryDto} plus the opaque slate cursor.
 *
 * BOTH parameters are accepted at once, on purpose. `before` is the original
 * chronological keyset an un-updated client still sends; `cursor` is the signed
 * ranked-slate token. When both arrive `cursor` wins, because a client that knows
 * about ranked pagination is the one that was given it.
 *
 * `cursor` is validated only as an opaque `payload.signature` token with a length
 * cap. Its authenticity is established by HMAC verification in the recommendation
 * layer — this keeps a malformed or absurdly large value from reaching that code
 * at all, and is not itself the trust boundary.
 */
export class FeedQueryDto extends CursorQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(16_384)
  @Matches(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, {
    message: 'cursor is not a valid pagination cursor.',
  })
  cursor?: string;
}

export function clampLimit(limit: number | undefined, fallback: number, max = 50): number {
  if (!limit || Number.isNaN(limit)) return fallback;
  return Math.min(Math.max(1, Math.trunc(limit)), max);
}

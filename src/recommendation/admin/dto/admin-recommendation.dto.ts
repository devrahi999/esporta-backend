import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * Admin DTOs for the recommendation surface.
 *
 * The config document arrives as a JSON object and is validated by the zod
 * schema in {@link validateRecommendationConfig} — class-validator could not
 * express the cross-field rules and bounds that schema enforces, so the DTO only
 * proves the request is shaped like a config write and the schema decides
 * whether it is one.
 *
 * Intervention bounds are enforced by BOTH this DTO and the database's CHECK
 * constraints (min 0.25 / max 3, and boost/suppress direction), so neither a
 * buggy client nor a direct SQL write can create an unbounded override.
 */
export class CreateConfigVersionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  label!: string;

  @IsObject()
  config!: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class ValidateConfigDto {
  @IsObject()
  config!: Record<string, unknown>;
}

export class ActivateConfigVersionDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;

  @IsOptional()
  @IsBoolean()
  rollback?: boolean;
}

export class AdminPagingDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10_000)
  offset?: number;
}

export class InterventionsQueryDto {
  /** 'true' includes expired/revoked rows (history view). */
  @IsOptional()
  @IsIn(['true', 'false'])
  includeExpired?: string;
}

export class CreateInterventionDto {
  @IsIn(['post', 'identity'])
  scope!: 'post' | 'identity';

  @IsUUID()
  scopeId!: string;

  @IsIn(['boost', 'suppress'])
  kind!: 'boost' | 'suppress';

  /**
   * The band matches the DB CHECK: boost ∈ (1, 3], suppress ∈ [0.25, 1). The
   * composed product across several live rows is separately clamped in the
   * ranker, so stacking cannot exceed the ceiling either.
   */
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.25)
  @Max(3)
  multiplier!: number;

  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;

  @IsISO8601()
  expiresAt!: string;

  @IsOptional()
  @IsIn(['feed', 'shorts', 'search'])
  surface?: 'feed' | 'shorts' | 'search';
}

export class RevokeInterventionDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

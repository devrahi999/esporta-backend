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
  Matches,
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

// ------------------------------------------------------------------ Phase 2

/** Date-range query for exposure analytics. Bounded to a 366-day window. */
export class WindowQueryDto {
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from must be an ISO date (YYYY-MM-DD).' })
  from!: string;

  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'to must be an ISO date (YYYY-MM-DD).' })
  to!: string;

  @IsOptional()
  @IsIn(['feed', 'shorts', 'search'])
  surface?: 'feed' | 'shorts' | 'search';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10_000)
  offset?: number;
}

export class TopPostsQueryDto extends WindowQueryDto {
  @IsOptional()
  @IsIn(['all', 'post', 'short'])
  kind?: 'all' | 'post' | 'short';
}

export class ContentStatsQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;

  @IsOptional()
  @IsIn(['all', 'post', 'short'])
  kind?: 'all' | 'post' | 'short';

  @IsOptional()
  @IsIn(['all', 'eligible', 'ineligible'])
  status?: 'all' | 'eligible' | 'ineligible';

  @IsOptional()
  @IsIn(['exposure', 'quality', 'impressions', 'newest'])
  sort?: 'exposure' | 'quality' | 'impressions' | 'newest';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10_000)
  offset?: number;
}

export class UsersOverviewQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;

  @IsOptional()
  @IsIn(['all', 'true', 'false'])
  coldStart?: 'all' | 'true' | 'false';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10_000)
  offset?: number;
}

export class DaysQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  days?: number;
}

export class ViewerControlsDto {
  @IsUUID()
  identityId!: string;

  /** null/omitted = the control applies to every surface. */
  @IsOptional()
  @IsIn(['feed', 'shorts', 'search'])
  surface?: 'feed' | 'shorts' | 'search';

  /**
   * The controls document: { boosts, suppress, exploration }. Shaped like an
   * object here; the DATABASE validates every key, band and dimension — the
   * same validator the ranker path relies on.
   */
  @IsObject()
  controls!: Record<string, unknown>;

  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;

  @IsISO8601()
  expiresAt!: string;
}

export class RevokeViewerControlsDto {
  @IsUUID()
  identityId!: string;

  @IsOptional()
  @IsIn(['feed', 'shorts', 'search'])
  surface?: 'feed' | 'shorts' | 'search';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class CreateExperimentDto {
  @IsString()
  @MinLength(3)
  @MaxLength(100)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsIn(['feed', 'shorts', 'search'])
  surface!: 'feed' | 'shorts' | 'search';

  @IsUUID()
  variantVersionId!: string;

  /** Variant share of eligible viewers; the DB enforces 1–50. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  variantPercent!: number;
}

export class ExperimentIdDto {
  @IsUUID()
  experimentId!: string;
}

export class StopExperimentDto extends ExperimentIdDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

import { Transform, Type } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import type { Granularity } from '../analytics-metrics';

/**
 * Query-string booleans arrive as strings; `@Type(() => Boolean)` would coerce
 * "false" to true. Mirrors the helper in `admin/dto/admin.dto.ts`.
 */
const ToBool = () =>
  Transform(({ value }) => {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value === 'boolean') return value;
    return value === 'true' || value === '1';
  });

/**
 * Ranking dimensions for content leaderboards.
 *
 * The four engagement components are separate orders so "most commented" and
 * "most saved" are real leaderboards ranked in SQL, not an engagement ranking
 * the operator has to eyeball. `completion` ranks by absolute completions, not
 * by rate — see the SQL comment in `analytics_entity_top`.
 */
export const CONTENT_ORDERS = [
  'views',
  'reach',
  'engagement',
  'impressions',
  'opens',
  'reactions',
  'comments',
  'shares',
  'saves',
  'watch_time',
  'completion',
] as const;
export type ContentOrder = (typeof CONTENT_ORDERS)[number];

/** Ranking dimensions for identity leaderboards. */
export const IDENTITY_ORDERS = [
  'reach',
  'views',
  'impressions',
  'engagement',
  'reactions',
  'comments',
  'shares',
  'saves',
  'profile_views',
  'followers',
  'watch_time',
  /** Distinct pieces of the identity's content with traffic in the range. */
  'content',
] as const;
export type IdentityOrder = (typeof IDENTITY_ORDERS)[number];

/** Shared query for every analytics read endpoint. */
export class AnalyticsQueryDto {
  /** Inclusive UTC start date, `YYYY-MM-DD`. */
  @IsDateString({ strict: true }) from!: string;

  /** Inclusive UTC end date, `YYYY-MM-DD`. */
  @IsDateString({ strict: true }) to!: string;

  /** Series bucket size. Weekly/monthly roll up from the daily layer. */
  @IsOptional() @IsIn(['day', 'week', 'month']) granularity?: Granularity;

  /** Page size for list-style reads (top content). */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) limit?: number;
}

/**
 * An overview read, optionally with the equal-length preceding window.
 *
 * `compare` is opt-in rather than always-on because it doubles the number of
 * rollup queries a request makes, and only the dashboard cards need it. The
 * response shape without it is byte-identical to the Part 2 contract, so adding
 * this parameter breaks no existing consumer.
 */
export class AnalyticsOverviewQueryDto extends AnalyticsQueryDto {
  @IsOptional() @ToBool() compare?: boolean;
}

/** Top-content read: ranked, filtered by kind, paginated. */
export class AnalyticsTopContentQueryDto extends AnalyticsQueryDto {
  @IsOptional() @IsIn(['post', 'short']) kind?: 'post' | 'short';

  @IsOptional() @IsIn(CONTENT_ORDERS as unknown as string[]) order?: ContentOrder;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}

/** Top-identities read: ranked, filtered by identity kind, paginated. */
export class AnalyticsTopIdentitiesQueryDto extends AnalyticsQueryDto {
  /** `personal` or `team`; omitted means both. */
  @IsOptional() @IsIn(['personal', 'team']) identityType?: 'personal' | 'team';

  @IsOptional() @IsIn(IDENTITY_ORDERS as unknown as string[]) order?: IdentityOrder;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}

/** Query for a single entity's content-performance read. */
export class AnalyticsContentQueryDto extends AnalyticsQueryDto {
  // `entityId` arrives as a route param, validated in the service.
}

/**
 * The reaction-type mix, optionally scoped to one content item or one author.
 *
 * Both scopes are optional and mutually compatible; omitting both asks the
 * platform-wide question. They are validated as uuids here AND in the service,
 * because the service method is also reachable from the identity- and
 * content-detail paths where no DTO runs.
 */
export class AnalyticsReactionMixQueryDto extends AnalyticsQueryDto {
  @IsOptional() @IsUUID() entityId?: string;

  @IsOptional() @IsUUID() identityId?: string;
}

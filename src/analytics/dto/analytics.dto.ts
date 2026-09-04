import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ANALYTICS_ENTITY_TYPES } from '../analytics.types';

export class AnalyticsEventDto {
  @IsString() @MinLength(1) @MaxLength(80) name!: string;

  /** What the event is about. Shorts are posts, so there is no 'short' kind. */
  @IsOptional() @IsString() @IsIn(ANALYTICS_ENTITY_TYPES) entity_type?: string;
  @IsOptional() @IsUUID('4') entity_id?: string;

  /**
   * Client-generated uuid (Analytics Part 1 §3). Unique where present, so a
   * retried batch cannot double-count an event — duplicates resolve to no-ops
   * server-side and are reported in the response.
   */
  @IsOptional() @IsUUID('4') event_id?: string;

  @IsOptional() @IsObject() properties?: Record<string, unknown>;
  @IsOptional() @IsString() @MaxLength(128) session_id?: string;
  @IsOptional() @IsString() @MaxLength(40) platform?: string;
  @IsOptional() @IsString() @MaxLength(40) app_version?: string;
}

export class IngestEventsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => AnalyticsEventDto)
  events!: AnalyticsEventDto[];
}

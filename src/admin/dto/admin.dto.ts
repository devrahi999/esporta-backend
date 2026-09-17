import { Transform, Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Query-string booleans arrive as strings; `@Type(() => Boolean)` would coerce
 * "false" to true. This maps "true"/"1" → true, "false"/"0" → false, and leaves
 * absent values undefined so optional filters stay unset.
 */
const ToBool = () =>
  Transform(({ value }) => {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value === 'boolean') return value;
    return value === 'true' || value === '1';
  });

// ---- shared query base ----
class PageQuery {
  @IsOptional() @Type(() => Number) @IsInt() limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() offset?: number;
  @IsOptional() @IsString() search?: string;
}

// ---- lists ----
export class AdminUsersQuery extends PageQuery {
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsString() kind?: string;
  @IsOptional() @ToBool() @IsBoolean() verified?: boolean;
  @IsOptional() @ToBool() @IsBoolean() owner?: boolean;
  @IsOptional() @ToBool() @IsBoolean() premium?: boolean;
  @IsOptional() @ToBool() @IsBoolean() restricted?: boolean;
  @IsOptional() @IsString() sort?: string;
}
export class AdminPostsQuery extends PageQuery {
  @IsOptional() @IsString() kind?: string;
  @IsOptional() @IsString() state?: string;
  @IsOptional() @IsUUID('4') author?: string;
  @IsOptional() @ToBool() @IsBoolean() reported?: boolean;
  @IsOptional() @IsString() sort?: string;
}
export class AdminCommentsQuery extends PageQuery {
  @IsOptional() @IsString() state?: string;
  @IsOptional() @IsUUID('4') author?: string;
  @IsOptional() @IsUUID('4') post?: string;
  @IsOptional() @ToBool() @IsBoolean() reported?: boolean;
}
export class AdminRecruitmentsQuery extends PageQuery {
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsString() game?: string;
  @IsOptional() @IsUUID('4') owner?: string;
}
export class AdminApplicationsQuery extends PageQuery {
  @IsOptional() @IsString() kind?: string;
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsUUID('4') recruitment?: string;
}
export class AdminReportsQuery extends PageQuery {
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsString() target_type?: string;
  @IsOptional() @IsString() reason?: string;
  @IsOptional() @IsString() sort?: string;
}
export class AdminTryoutsQuery extends PageQuery {
  @IsOptional() @IsString() status?: string;
}
export class AdminSupportQuery extends PageQuery {
  @IsOptional() @IsString() status?: string;
}
export class AdminVerificationQuery extends PageQuery {
  @IsOptional() @IsString() kind?: string;
  @IsOptional() @IsString() status?: string;
}
export class AdminNotificationsQuery extends PageQuery {
  @IsOptional() @IsString() type?: string;
  @IsOptional() @ToBool() @IsBoolean() unread_only?: boolean;
}
export class AdminAuditQuery extends PageQuery {
  @IsOptional() @IsString() action?: string;
  @IsOptional() @IsUUID('4') admin?: string;
  @IsOptional() @IsUUID('4') target?: string;
  @IsOptional() @IsString() target_type?: string;
  @IsOptional() @IsISO8601() since?: string;
}
export class AdminSearchQuery {
  @IsString() q!: string;
  @IsOptional() @IsString() kind?: string;
  @IsOptional() @Type(() => Number) @IsInt() limit?: number;
}

// ---- write bodies ----
export class ModerateDto {
  @IsString() action!: string;
  @IsOptional() @IsString() @MaxLength(1000) reason?: string;
}
export class SetIdentityStatusDto {
  @IsString() status!: string;
  @IsOptional() @IsString() @MaxLength(1000) reason?: string;
}
export class SetOwnerDto {
  @IsBoolean() owner!: boolean;
  @IsOptional() @IsString() @MaxLength(1000) reason?: string;
}

export class SetVerifiedDto {
  @IsBoolean() verified!: boolean;
  @IsOptional() @IsString() @MaxLength(1000) reason?: string;
}
export class SetPremiumDto {
  @IsBoolean() premium!: boolean;
  @IsOptional() @IsString() @MaxLength(1000) reason?: string;
}
export class RestrictDto {
  @Type(() => Number) @IsInt() days!: number;
  @IsOptional() @IsString() @MaxLength(1000) reason?: string;
}
export class ResolveReportDto {
  @IsString() status!: string;
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}

// ---- platform controls & per-user restrictions (plan Parts 3/4) ----
export class AdminRecentPostsQuery {
  /** ISO timestamps bounding the review window; defaults to last 24h. */
  @IsOptional() @IsISO8601() from?: string;
  @IsOptional() @IsISO8601() to?: string;
  /** all | post | short | image | video */
  @IsOptional() @IsIn(['all', 'post', 'short', 'image', 'video']) kind?: string;
  /** all | published | under_review | restricted | removed */
  @IsOptional() @IsIn(['all', 'published', 'under_review', 'restricted', 'removed']) moderation?: string;
  @IsOptional() @ToBool() @IsBoolean() reported?: boolean;
  @IsOptional() @IsString() @MaxLength(200) search?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10_000) offset?: number;
}
export class SetPlatformControlDto {
  @IsBoolean() enabled!: boolean;
  @IsOptional() @IsString() @MaxLength(1000) reason?: string;
  /** Maintenance-only: the message users see on the maintenance screen. */
  @IsOptional() @IsString() @MaxLength(300) message?: string;
  /** Maintenance-only: optional estimated return time. */
  @IsOptional() @IsISO8601() eta?: string;
}
export class SetUserRestrictionDto {
  /** post_creation | upload_images | upload_videos | upload_shorts | comments */
  @IsIn(['post_creation', 'upload_images', 'upload_videos', 'upload_shorts', 'comments'])
  feature!: string;
  @IsBoolean() restricted!: boolean;
  @IsOptional() @IsString() @MaxLength(1000) reason?: string;
  /** Null = permanent; a future timestamp makes the restriction temporary. */
  @IsOptional() @IsISO8601() expiresAt?: string;
}
export class SetSuspendedDto {
  @IsBoolean() suspended!: boolean;
  @IsOptional() @IsString() @MaxLength(1000) reason?: string;
}
export class DecideVerificationDto {
  /**
   * `approve` | `reject` | `not_eligible`. A tri-state, not a boolean: the RPC
   * treats `not_eligible` differently from `reject` (a 90-day reapply cooldown
   * instead of 7), so collapsing it into a boolean would make that decision
   * unreachable.
   */
  @IsIn(['approve', 'reject', 'not_eligible']) decision!: 'approve' | 'reject' | 'not_eligible';
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
  /** Overrides the default cooldown for a rejection. Omitted uses the default. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(365) cooldown_days?: number;
}
export class VerificationControlDto {
  /** `followers` | `views` | `both` — which metric(s) gate eligibility. */
  @IsIn(['followers', 'views', 'both']) mode!: 'followers' | 'views' | 'both';
  @Type(() => Number) @IsInt() @Min(0) followers_required!: number;
  @Type(() => Number) @IsInt() @Min(0) views_required!: number;
}
export class PermanentDeleteDto {
  @IsArray() @ArrayNotEmpty() @IsUUID('4', { each: true }) ids!: string[];
}

export class ReplyTicketDto {
  @IsString() @MaxLength(4000) body!: string;
}
export class SetTicketStatusDto {
  @IsString() status!: string;
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}
export class UpsertFaqDto {
  @IsOptional() @IsUUID('4') id?: string;
  @IsObject() patch!: Record<string, unknown>;
  @IsOptional() @IsString() note?: string;
}
export class SetFaqActiveDto {
  @IsBoolean() active!: boolean;
  @IsOptional() @IsString() note?: string;
}
export class ReorderFaqDto {
  @IsArray() @IsUUID('4', { each: true }) ids!: string[];
  @IsOptional() @IsString() note?: string;
}
export class UpsertReferenceDto {
  @IsString() kind!: string;
  @IsString() id!: string;
  @IsObject() patch!: Record<string, unknown>;
  @IsOptional() @IsString() note?: string;
}
export class SetReferenceActiveDto {
  @IsString() kind!: string;
  @IsString() id!: string;
  @IsBoolean() active!: boolean;
  @IsOptional() @IsString() note?: string;
}
export class ReorderReferenceDto {
  @IsString() kind!: string;
  @IsArray() @IsString({ each: true }) ids!: string[];
  @IsOptional() @IsString() note?: string;
}
export class UpsertAdminDto {
  @IsUUID('4') identity!: string;
  @IsString() level!: string;
  @IsOptional() @IsString() note?: string;
}
export class NoteDto {
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}
export class DisableAdminDto {
  @IsBoolean() disabled!: boolean;
  @IsOptional() @IsString() note?: string;
}
export class SetRoleCapabilityDto {
  @IsString() level!: string;
  @IsString() capability!: string;
  @IsBoolean() enabled!: boolean;
}
export class SendNotificationDto {
  @IsArray() @IsUUID('4', { each: true }) recipients!: string[];
  @IsString() type!: string;
  @IsString() @MaxLength(200) title!: string;
  // Optional: the console's compose form allows a title-only notification and
  // normalises an untouched textarea to null before sending.
  @IsOptional() @IsString() @MaxLength(2000) body?: string;
  @IsOptional() @IsString() entity?: string;
  @IsOptional() @IsUUID('4') entity_id?: string;
  @IsOptional() @IsString() note?: string;
}
export class AnnounceDto {
  @IsString() @MaxLength(200) title!: string;
  @IsString() @MaxLength(2000) body!: string;
  @IsString() audience!: string;
}

/** `GET /admin/timeseries` — the dashboard's trend window. */
export class AdminTimeseriesQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(365) days?: number;
}

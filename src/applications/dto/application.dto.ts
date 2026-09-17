import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export const APPLICATION_STATUS = ['pending', 'shortlisted', 'accepted', 'rejected', 'withdrawn'] as const;

/**
 * A sponsorship is a third kind of negotiation on the same table, not a hire
 * under another name: nobody joins a roster at the end of it, there is no tryout
 * in the middle, and the two sides are a sponsor and the party being sponsored.
 *
 * Which pairs of profiles may actually file one is decided in Postgres by
 * `guard_application_capability` (one side has to be able to sponsor, the other
 * to be sponsored) — this list only says the word is spellable.
 */
export const APPLICATION_KIND = ['application', 'hire', 'sponsorship'] as const;
export const MESSAGE_KIND = ['reply', 'tryout_request'] as const;

/** Personal roles a queue can be filtered by — `roles.id`. */
export const APPLICATION_ROLE_FILTER = [
  'player',
  'coach',
  'manager',
  'analyst',
  'content_creator',
  'caster',
] as const;

export class CreateApplicationDto {
  @IsUUID('4') target_id!: string;
  @IsOptional() @IsUUID('4') recruitment_id?: string;
  @IsOptional() @IsString() @MaxLength(2000) message?: string;
  @IsIn(APPLICATION_KIND) kind!: string;
}

/**
 * Filters for `GET /applications`.
 *
 * Real filters, applied to the query rather than to the response: `kind` and
 * `status` are columns on the row, and `role` narrows on the counterparty's
 * `profiles.primary_role_id` through an inner-joined embed, so a filtered request
 * returns fewer rows instead of the same page with some hidden.
 */
export class ApplicationQueryDto {
  @IsOptional() @IsIn(APPLICATION_KIND) kind?: string;
  @IsOptional() @IsIn(APPLICATION_STATUS) status?: string;
  @IsOptional() @IsIn(APPLICATION_ROLE_FILTER) role?: string;
  @IsOptional() @IsInt() @Min(1) @Max(200) limit?: number;
}

export class RespondApplicationDto {
  @IsIn(APPLICATION_STATUS) status!: string;
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
}

export class RejectApplicationDto {
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
}

export class AcceptApplicationDto {
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
  @IsOptional() @IsBoolean() add_to_roster?: boolean;
}

export class SendMessageDto {
  @IsIn(MESSAGE_KIND) kind!: string;
  @IsString() @MinLength(1) @MaxLength(2000) message!: string;
}

export class MarkMessagesReadDto {
  @IsArray() @IsUUID('4', { each: true }) ids!: string[];
}

/**
 * `POST /applications/hide` — remove rows from the caller's own list.
 *
 * Ids and nothing else, on purpose. There is no "which side" field because the
 * side is derived server-side from the caller's identity; a body that could name
 * a column would be a body that could hide somebody else's copy. Capped at the
 * page size the list itself fetches, so "select all then delete" is one request.
 */
export class HideApplicationsDto {
  @IsArray() @ArrayNotEmpty() @ArrayMaxSize(200) @IsUUID('4', { each: true }) ids!: string[];
}

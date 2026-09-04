import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import {
  ALLOWED_IMAGE_MIME,
  MAX_IMAGE_BYTES,
  MEDIA_ENTITY_TYPES,
  MEDIA_SLOTS,
} from '../media.constants';

export class CreateImageUploadSessionDto {
  @IsIn(MEDIA_ENTITY_TYPES) entity_type!: string;
  @IsIn(MEDIA_SLOTS) slot!: string;
  @IsIn(ALLOWED_IMAGE_MIME) content_type!: string;
  @IsOptional() @IsString() @MaxLength(200) file_name?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(MAX_IMAGE_BYTES) file_size?: number;
}

export class CompleteImageUploadDto {
  @IsString() @MaxLength(300) key!: string;
  @IsIn(MEDIA_ENTITY_TYPES) entity_type!: string;
  @IsIn(MEDIA_SLOTS) slot!: string;
  @IsOptional() @IsUUID('4') post_id?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) width?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) height?: number;
}

export class ReplaceImageSessionDto {
  @IsIn(ALLOWED_IMAGE_MIME) content_type!: string;
  @IsOptional() @IsString() @MaxLength(200) file_name?: string;
}

export class CompleteReplaceDto {
  @IsString() @MaxLength(300) key!: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) width?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) height?: number;
}

export class CreateVideoUploadSessionDto {
  // Videos are post/Short attachments. Cloudflare Stream caps the duration.
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(3600) max_duration_seconds?: number;
  @IsOptional() @IsString() @MaxLength(200) file_name?: string;
  @IsOptional() @IsUUID('4') post_id?: string;
}

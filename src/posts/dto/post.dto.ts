import {
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export const POST_VISIBILITY = ['public', 'followers', 'private'] as const;

export class CreatePostDto {
  @IsString() type_id!: string;
  @IsOptional() @IsString() @MaxLength(5000) caption?: string;
  @IsOptional() @IsIn(POST_VISIBILITY) visibility?: string;
  @IsOptional() @IsArray() @IsUUID('4', { each: true }) media_ids?: string[];
}

export class UpdateCaptionDto {
  @IsString() @MaxLength(5000) caption!: string;
}

export class MediaIdsDto {
  @IsArray() @IsUUID('4', { each: true }) media_ids!: string[];
}

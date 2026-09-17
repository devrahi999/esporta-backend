import { IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class AddCommentDto {
  @IsString() @MinLength(1) @MaxLength(2000) body!: string;
  @IsOptional() @IsUUID('4') parent_id?: string;
}

export class EditCommentDto {
  @IsString() @MinLength(1) @MaxLength(2000) body!: string;
}

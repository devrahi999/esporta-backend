import { IsString, MaxLength, MinLength } from 'class-validator';

export class RegisterGameDto {
  @IsString() @MinLength(1) @MaxLength(60) name!: string;
}

export class RegisterRoleDto {
  @IsString() @MinLength(1) @MaxLength(60) label!: string;
}

export class RegisterGameRoleDto {
  @IsString() game_id!: string;
  @IsString() @MinLength(1) @MaxLength(60) label!: string;
}

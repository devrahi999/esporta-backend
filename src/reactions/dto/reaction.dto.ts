import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class ReactDto {
  @IsOptional() @IsString() type_id?: string;
}

export class ReactorsQueryDto {
  @IsOptional() @IsString() type?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}

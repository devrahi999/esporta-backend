import { IsArray, IsUUID } from 'class-validator';

export class MarkReadDto {
  @IsArray() @IsUUID('4', { each: true }) ids!: string[];
}

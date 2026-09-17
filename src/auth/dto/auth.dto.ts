import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

export class AuthLoginDto {
  @IsEmail()
  email!: string;

  // Length-bounded both ways: the floor keeps empty strings out of the Supabase
  // round-trip, the ceiling caps the bytes a credential-guessing client can
  // make the auth service hash.
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  password!: string;
}

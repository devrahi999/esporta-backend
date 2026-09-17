import { Body, Controller, Post } from '@nestjs/common';
import { IsEmail, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { AccountRecoveryService } from './account-recovery.service';
import { Public } from '../common/decorators/public.decorator';

class AccountRecoveryDto {
  @IsIn(['start', 'verify']) action!: string;
  @IsEmail() @MaxLength(254) email!: string;
  @IsOptional() @IsString() @MaxLength(12) code?: string;
}

/**
 * `/api/v1/auth/account-recovery` — public (signed-out), because the caller has
 * by definition no session. Security comes from the OTP proof plus responses
 * generic enough never to reveal whether an address is on file.
 */
@Public()
@Controller('auth/account-recovery')
export class AccountRecoveryController {
  constructor(private readonly recovery: AccountRecoveryService) {}

  @Post()
  handle(@Body() dto: AccountRecoveryDto) {
    if (dto.action === 'start') return this.recovery.start(dto.email);
    return this.recovery.verify(dto.email, dto.code ?? '');
  }
}

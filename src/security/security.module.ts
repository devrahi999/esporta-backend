import { Module } from '@nestjs/common';
import { SecurityController } from './security.controller';
import { SecurityService } from './security.service';
import { AccountRecoveryController } from './account-recovery.controller';
import { AccountRecoveryService } from './account-recovery.service';

@Module({
  controllers: [SecurityController, AccountRecoveryController],
  providers: [SecurityService, AccountRecoveryService],
  exports: [SecurityService],
})
export class SecurityModule {}

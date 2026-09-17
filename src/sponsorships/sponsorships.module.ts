import { Module } from '@nestjs/common';
import { SponsorshipsController } from './sponsorships.controller';
import { SponsorshipsService } from './sponsorships.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [SponsorshipsController],
  providers: [SponsorshipsService],
  exports: [SponsorshipsService],
})
export class SponsorshipsModule {}

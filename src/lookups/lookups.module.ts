import { Module } from '@nestjs/common';
import { LookupsController } from './lookups.controller';
import { LookupsService } from './lookups.service';
import { AuthModule } from '../auth/auth.module';

// AuthModule for `OptionalAuthGuard` — `GET /lookups` is public but reads richer
// for a signed-in caller.
@Module({
  imports: [AuthModule],
  controllers: [LookupsController],
  providers: [LookupsService],
})
export class LookupsModule {}

import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { SupabaseModule } from '../supabase/supabase.module';
import { PlatformModule } from '../platform/platform.module';

@Module({
  imports: [SupabaseModule, PlatformModule],
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}

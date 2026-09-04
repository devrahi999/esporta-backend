import { Global, Module } from '@nestjs/common';
import { SupabaseService } from './supabase.service';

/**
 * Global so any feature module can inject {@link SupabaseService} without
 * re-importing. The service itself decides caller-scoped vs service-role.
 */
@Global()
@Module({
  providers: [SupabaseService],
  exports: [SupabaseService],
})
export class SupabaseModule {}

import { Module } from '@nestjs/common';
import { TryoutsController } from './tryouts.controller';
import { TryoutsService } from './tryouts.service';

@Module({
  controllers: [TryoutsController],
  providers: [TryoutsService],
  exports: [TryoutsService],
})
export class TryoutsModule {}

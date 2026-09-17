import { Controller, Get } from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator';
import { HealthService } from './health.service';

/**
 * Health endpoints (plan §34). Public and mounted outside the /api/v1 prefix so
 * uptime monitors can hit `/health` directly.
 */
@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  root() {
    return this.health.liveness();
  }

  @Get('full')
  full() {
    return this.health.full();
  }

  @Get('db')
  db() {
    return this.health.database();
  }

  @Get('storage')
  storage() {
    return this.health.storage();
  }

  @Get('stream')
  stream() {
    return this.health.stream();
  }
}

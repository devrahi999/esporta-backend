import { Module } from '@nestjs/common';
import { PublicController } from './public.controller';
import { PublicService } from './public.service';

/**
 * Link previews for `app.esporta.site`. No `AuthModule` import on purpose —
 * every route here is `@Public()` and reads as `anon`, so there is nothing for a
 * guard to do. See {@link PublicController} for the security posture.
 */
@Module({
  controllers: [PublicController],
  providers: [PublicService],
})
export class PublicModule {}

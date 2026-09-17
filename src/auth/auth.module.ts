import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { ActiveProfileGuard } from './guards/active-profile.guard';
import { OptionalAuthGuard } from './guards/optional-auth.guard';

/**
 * Wires JWT verification (plan §6). {@link JwtAuthGuard} is registered globally,
 * so every route is protected unless `@Public()`. {@link ActiveProfileGuard} is
 * exported for opt-in use on profile-scoped routes, and
 * {@link OptionalAuthGuard} for `@Public()` routes whose answer is richer when
 * the caller happens to be signed in.
 */
@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    ActiveProfileGuard,
    OptionalAuthGuard,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
  exports: [AuthService, ActiveProfileGuard, OptionalAuthGuard],
})
export class AuthModule {}

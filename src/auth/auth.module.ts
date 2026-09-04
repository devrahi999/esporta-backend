import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { ActiveProfileGuard } from './guards/active-profile.guard';

/**
 * Wires JWT verification (plan §6). {@link JwtAuthGuard} is registered globally,
 * so every route is protected unless `@Public()`. {@link ActiveProfileGuard} is
 * exported for opt-in use on profile-scoped routes.
 */
@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    ActiveProfileGuard,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
  exports: [AuthService, ActiveProfileGuard],
})
export class AuthModule {}

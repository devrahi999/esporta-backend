import 'reflect-metadata';
import {
  INestApplication,
  RequestMethod,
  ValidationPipe,
} from '@nestjs/common';
import helmet from 'helmet';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppConfigService } from './config/app-config.service';

/**
 * Every cross-cutting concern, applied to an already-created Nest app: security
 * headers, the route prefix, the validation pipe, and CORS.
 *
 * Separate from {@link ../main.ts} so the entrypoint reads as an entrypoint and
 * this stays the one place the app-wide policy lives. It deliberately does NOT
 * create the app: `NestFactory` belongs in `main.ts`, which is both the Nest
 * convention and what Vercel's NestJS detection looks for — it scans the
 * entrypoint for an `@nestjs/core` import and refuses to build without one
 * ("No entrypoint found which imports nestjs").
 *
 * DI-level cross-cutting concerns (the global rate-limit guard) are registered
 * in {@link ../app.module.ts} via `APP_GUARD`, where Nest can inject the
 * guard's own dependencies.
 */
export function configureApp(app: INestApplication): void {
  const config = app.get(AppConfigService);

  // Helmet's baseline first (CSP off — JSON API; COEP off — embeds would break),
  // then the app-specific header policy on top: SecurityHeadersMiddleware (see
  // app.module.ts) adds the CORS-adjacent and proxy-aware headers helmet
  // cannot decide for us.
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
    }),
  );
  // The platform edge terminates TLS and sets X-Forwarded-*, so Express may
  // trust exactly one proxy hop: `req.ip`/`req.secure` then reflect the real
  // client (used by rate-limit tracking and the HSTS header decision).
  (app as NestExpressApplication).set('trust proxy', 1);

  // All app routes under /api/v1 (plan §31); health stays at /health (§34).
  app.setGlobalPrefix('api/v1', {
    exclude: [
      { path: 'health', method: RequestMethod.GET },
      { path: 'health/(.*)', method: RequestMethod.GET },
    ],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // Allow-list only; never wildcard in production (plan §36).
  const origins = config.appOrigins;
  app.enableCors({
    origin: origins.length > 0 ? origins : false,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'X-Active-Profile-Id',
      'X-Request-Id',
      'x-dispatch-secret',
    ],
    exposedHeaders: ['x-request-id'],
    maxAge: 600,
  });
}

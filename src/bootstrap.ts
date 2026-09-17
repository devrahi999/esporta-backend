import 'reflect-metadata';
import { INestApplication, RequestMethod, ValidationPipe } from '@nestjs/common';
import { AppConfigService } from './config/app-config.service';

/**
 * Every cross-cutting concern, applied to an already-created Nest app: the route
 * prefix, the validation pipe, and CORS.
 *
 * Separate from {@link ../main.ts} so the entrypoint reads as an entrypoint and
 * this stays the one place the app-wide policy lives. It deliberately does NOT
 * create the app: `NestFactory` belongs in `main.ts`, which is both the Nest
 * convention and what Vercel's NestJS detection looks for — it scans the
 * entrypoint for an `@nestjs/core` import and refuses to build without one
 * ("No entrypoint found which imports nestjs").
 */
export function configureApp(app: INestApplication): void {
  const config = app.get(AppConfigService);

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

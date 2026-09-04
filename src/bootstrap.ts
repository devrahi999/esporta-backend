import 'reflect-metadata';
import { INestApplication, RequestMethod, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import type { Express } from 'express';
import { AppModule } from './app.module';
import { AppLogger } from './common/logger/app-logger';
import { AppConfigService } from './config/app-config.service';

/**
 * Builds and initialises the Nest application, applying every cross-cutting
 * concern (prefix, validation, CORS). It calls `app.init()` but NOT
 * `app.listen()`, so the same function serves both the local server (main.ts)
 * and the Vercel serverless handler (api/index.ts) — a short-lived request/
 * response model, per plan §41.
 *
 * @param expressInstance when provided, Nest binds to it so a serverless entry
 * can hand the raw Express app to Vercel's Node runtime.
 */
export async function createNestApp(expressInstance?: Express): Promise<INestApplication> {
  const logger = new AppLogger('Esporta');

  const app = expressInstance
    ? await NestFactory.create(AppModule, new ExpressAdapter(expressInstance), { logger, rawBody: true })
    : await NestFactory.create(AppModule, { logger, rawBody: true });

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

  await app.init();
  return app;
}

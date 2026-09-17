import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';
import { AppLogger } from './common/logger/app-logger';
import { AppConfigService } from './config/app-config.service';

/**
 * The one entry point, local and deployed alike.
 *
 * `NestFactory` is called *here* rather than behind a helper, and that placement
 * is load-bearing on Vercel: its NestJS support identifies the app by finding an
 * entrypoint under `sourceRoot` that imports `@nestjs/core`. When this file only
 * imported a `createNestApp()` helper, the build failed with "No entrypoint found
 * which imports nestjs. Found possible entrypoint: src/main.ts" — it had found the
 * right file and rejected it for having no Nest import. It is also simply the Nest
 * convention.
 *
 * Cross-cutting configuration lives in {@link configureApp}, so this file stays
 * "create, configure, listen" and nothing else.
 *
 * `config.port` is `process.env.PORT` (default 3000), which is what the platform
 * injects — so the same `listen` serves `npm run start:prod` and the deployment.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    logger: new AppLogger('Esporta'),
    rawBody: true,
  });

  configureApp(app);

  const config = app.get(AppConfigService);
  await app.listen(config.port);
  // eslint-disable-next-line no-console
  console.log(`esporta-backend listening on :${config.port} (${config.nodeEnv})`);
}

void bootstrap();

import { createNestApp } from './bootstrap';
import { AppConfigService } from './config/app-config.service';

/**
 * Local / long-running entry point. On Vercel the app is served through
 * `api/index.ts` instead; this is `npm run start`.
 */
async function bootstrap(): Promise<void> {
  const app = await createNestApp();
  const config = app.get(AppConfigService);
  await app.listen(config.port);
  // eslint-disable-next-line no-console
  console.log(`esporta-backend listening on :${config.port} (${config.nodeEnv})`);
}

void bootstrap();

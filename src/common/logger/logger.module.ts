import { Global, Module } from '@nestjs/common';
import { AppLogger } from './app-logger';

/**
 * Provides the shared {@link AppLogger} instance for injection into the global
 * interceptors and exception filter. The same instance is also installed as the
 * Nest application logger in `bootstrap`.
 */
@Global()
@Module({
  providers: [{ provide: AppLogger, useValue: new AppLogger('Esporta') }],
  exports: [AppLogger],
})
export class LoggerModule {}

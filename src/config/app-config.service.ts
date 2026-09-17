import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  AppConfig,
  FirebaseConfig,
  R2Config,
  SecurityConfig,
  SmtpConfig,
  StreamConfig,
  SupabaseConfig,
} from './env.validation';

/**
 * Type-safe accessor over the validated {@link AppConfig}. Feature modules inject
 * this instead of reading `process.env`, so the only place a variable name
 * appears is {@link validateEnv}.
 */
@Injectable()
export class AppConfigService {
  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  get nodeEnv(): AppConfig['nodeEnv'] {
    return this.config.get('nodeEnv', { infer: true });
  }

  get isProduction(): boolean {
    return this.config.get('isProduction', { infer: true });
  }

  get port(): number {
    return this.config.get('port', { infer: true });
  }

  get apiBaseUrl(): string | undefined {
    return this.config.get('apiBaseUrl', { infer: true });
  }

  get appOrigins(): string[] {
    return this.config.get('appOrigins', { infer: true });
  }

  get supabase(): SupabaseConfig {
    return this.config.get('supabase', { infer: true });
  }

  get r2(): R2Config {
    return this.config.get('r2', { infer: true });
  }

  get stream(): StreamConfig {
    return this.config.get('stream', { infer: true });
  }

  get firebase(): FirebaseConfig {
    return this.config.get('firebase', { infer: true });
  }

  get smtp(): SmtpConfig {
    return this.config.get('smtp', { infer: true });
  }

  get security(): SecurityConfig {
    return this.config.get('security', { infer: true });
  }
}

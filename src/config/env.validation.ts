import { z } from 'zod';

/**
 * Environment schema + typed, grouped config.
 *
 * plan.md §10 lists every variable; §33 forbids logging secrets. Only Supabase
 * connectivity is required to boot — R2 / Stream / FCM / SMTP are optional so the
 * backend can run (and report health) before every integration is wired, which
 * is what makes the shadow-migration in §25 possible.
 *
 * The new backend uses the plan's `R2_*` names but also accepts the existing
 * edge-function names (`CLOUDFLARE_R2_*`) so ops can reuse current secrets during
 * cutover. Firebase private keys are normalised from literal `\n`.
 */

const bool = (v: string | undefined): boolean => !!v && v.trim().length > 0;
const first = (...vals: Array<string | undefined>): string | undefined =>
  vals.find((v) => v !== undefined && v.trim().length > 0)?.trim();

const RawSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'preview', 'production', 'test'])
      .default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    API_BASE_URL: z.string().url().optional(),
    APP_ORIGIN: z.string().optional(),

    SUPABASE_URL: z.string().url({ message: 'SUPABASE_URL must be a valid URL' }),
    SUPABASE_ANON_KEY: z.string().min(1, 'SUPABASE_ANON_KEY is required'),
    SUPABASE_SERVICE_ROLE_KEY: z
      .string()
      .min(1, 'SUPABASE_SERVICE_ROLE_KEY is required'),

    // Cloudflare R2 (plan names + legacy aliases)
    R2_ACCOUNT_ID: z.string().optional(),
    CLOUDFLARE_R2_ACCOUNT_ID: z.string().optional(),
    R2_ACCESS_KEY_ID: z.string().optional(),
    CLOUDFLARE_R2_ACCESS_KEY_ID: z.string().optional(),
    R2_SECRET_ACCESS_KEY: z.string().optional(),
    CLOUDFLARE_R2_SECRET_ACCESS_KEY: z.string().optional(),
    R2_BUCKET: z.string().optional(),
    CLOUDFLARE_R2_BUCKET: z.string().optional(),
    R2_PUBLIC_BASE_URL: z.string().optional(),
    CLOUDFLARE_R2_PUBLIC_URL: z.string().optional(),
    R2_ENDPOINT: z.string().optional(),
    CLOUDFLARE_R2_ENDPOINT: z.string().optional(),

    // Cloudflare Stream
    CLOUDFLARE_ACCOUNT_ID: z.string().optional(),
    CLOUDFLARE_STREAM_API_TOKEN: z.string().optional(),
    CLOUDFLARE_STREAM_WEBHOOK_SECRET: z.string().optional(),

    // Firebase / FCM
    FIREBASE_PROJECT_ID: z.string().optional(),
    FIREBASE_CLIENT_EMAIL: z.string().optional(),
    FIREBASE_PRIVATE_KEY: z.string().optional(),

    // Gmail SMTP
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().positive().default(465),
    SMTP_USERNAME: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
    SMTP_FROM_EMAIL: z.string().optional(),

    // Security / internal
    INTERNAL_WEBHOOK_SECRET: z.string().optional(),
    ENCRYPTION_KEY: z.string().optional(),
  })
  .passthrough();

export type RawEnv = z.infer<typeof RawSchema>;

export interface SupabaseConfig {
  url: string;
  anonKey: string;
  serviceRoleKey: string;
}

export interface R2Config {
  configured: boolean;
  accountId?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  bucket?: string;
  publicBaseUrl?: string;
  endpoint?: string;
}

export interface StreamConfig {
  configured: boolean;
  accountId?: string;
  apiToken?: string;
  webhookSecret?: string;
}

export interface FirebaseConfig {
  configured: boolean;
  projectId?: string;
  clientEmail?: string;
  privateKey?: string;
}

export interface SmtpConfig {
  configured: boolean;
  host?: string;
  port: number;
  username?: string;
  password?: string;
  fromEmail?: string;
}

export interface SecurityConfig {
  internalWebhookSecret?: string;
  encryptionKey?: string;
}

export interface AppConfig {
  nodeEnv: 'development' | 'preview' | 'production' | 'test';
  isProduction: boolean;
  port: number;
  apiBaseUrl?: string;
  appOrigins: string[];
  supabase: SupabaseConfig;
  r2: R2Config;
  stream: StreamConfig;
  firebase: FirebaseConfig;
  smtp: SmtpConfig;
  security: SecurityConfig;
}

const DEV_ORIGINS = ['http://localhost:3000', 'http://localhost:8080'];

function parseOrigins(raw: string | undefined, isProd: boolean): string[] {
  const list = (raw ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
  if (list.length > 0) return Array.from(new Set(list));
  // Never fall back to a wildcard in production (plan §36).
  return isProd ? [] : DEV_ORIGINS;
}

/**
 * @nestjs/config `validate` hook. Throws with a readable message on bad config
 * (fail fast at boot) and returns the typed, grouped {@link AppConfig}.
 */
export function validateEnv(raw: Record<string, unknown>): AppConfig {
  const parsed = RawSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const e = parsed.data;
  const isProduction = e.NODE_ENV === 'production';

  const r2 = {
    accountId: first(e.R2_ACCOUNT_ID, e.CLOUDFLARE_R2_ACCOUNT_ID),
    accessKeyId: first(e.R2_ACCESS_KEY_ID, e.CLOUDFLARE_R2_ACCESS_KEY_ID),
    secretAccessKey: first(
      e.R2_SECRET_ACCESS_KEY,
      e.CLOUDFLARE_R2_SECRET_ACCESS_KEY,
    ),
    bucket: first(e.R2_BUCKET, e.CLOUDFLARE_R2_BUCKET),
    publicBaseUrl: first(e.R2_PUBLIC_BASE_URL, e.CLOUDFLARE_R2_PUBLIC_URL),
    endpoint: first(e.R2_ENDPOINT, e.CLOUDFLARE_R2_ENDPOINT),
  };
  const r2Endpoint =
    r2.endpoint ??
    (r2.accountId ? `https://${r2.accountId}.r2.cloudflarestorage.com` : undefined);

  const firebasePrivateKey = e.FIREBASE_PRIVATE_KEY
    ? e.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
    : undefined;

  return {
    nodeEnv: e.NODE_ENV,
    isProduction,
    port: e.PORT,
    apiBaseUrl: e.API_BASE_URL,
    appOrigins: parseOrigins(e.APP_ORIGIN, isProduction),
    supabase: {
      url: e.SUPABASE_URL,
      anonKey: e.SUPABASE_ANON_KEY,
      serviceRoleKey: e.SUPABASE_SERVICE_ROLE_KEY,
    },
    r2: {
      configured: bool(r2.accessKeyId) && bool(r2.secretAccessKey) && bool(r2Endpoint) && bool(r2.publicBaseUrl),
      accountId: r2.accountId,
      accessKeyId: r2.accessKeyId,
      secretAccessKey: r2.secretAccessKey,
      bucket: r2.bucket ?? 'esporta',
      publicBaseUrl: r2.publicBaseUrl,
      endpoint: r2Endpoint,
    },
    stream: {
      configured: bool(e.CLOUDFLARE_ACCOUNT_ID) && bool(e.CLOUDFLARE_STREAM_API_TOKEN),
      accountId: e.CLOUDFLARE_ACCOUNT_ID,
      apiToken: e.CLOUDFLARE_STREAM_API_TOKEN,
      webhookSecret: e.CLOUDFLARE_STREAM_WEBHOOK_SECRET,
    },
    firebase: {
      configured: bool(e.FIREBASE_PROJECT_ID) && bool(e.FIREBASE_CLIENT_EMAIL) && bool(firebasePrivateKey),
      projectId: e.FIREBASE_PROJECT_ID,
      clientEmail: e.FIREBASE_CLIENT_EMAIL,
      privateKey: firebasePrivateKey,
    },
    smtp: {
      configured: bool(e.SMTP_HOST) && bool(e.SMTP_USERNAME) && bool(e.SMTP_PASSWORD),
      host: e.SMTP_HOST,
      port: e.SMTP_PORT,
      username: e.SMTP_USERNAME,
      password: e.SMTP_PASSWORD,
      fromEmail: first(e.SMTP_FROM_EMAIL, e.SMTP_USERNAME),
    },
    security: {
      internalWebhookSecret: e.INTERNAL_WEBHOOK_SECRET,
      encryptionKey: e.ENCRYPTION_KEY,
    },
  };
}

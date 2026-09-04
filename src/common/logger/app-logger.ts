import { LoggerService, LogLevel } from '@nestjs/common';

/**
 * Keys whose values must never appear in logs (plan.md §33). Matched
 * case-insensitively as a substring, so `smtp_password`, `X-Dispatch-Secret`
 * and `firebase_private_key` are all caught.
 */
const REDACT_PATTERNS = [
  'password',
  'passwd',
  'secret',
  'token',
  'authorization',
  'apikey',
  'api_key',
  'otp',
  'code',
  'private_key',
  'service_role',
  'encryption_key',
  'cookie',
];

const REDACTED = '[redacted]';
const MAX_DEPTH = 6;

function shouldRedact(key: string): boolean {
  const k = key.toLowerCase();
  return REDACT_PATTERNS.some((p) => k.includes(p));
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[truncated]';
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = shouldRedact(k) ? REDACTED : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export interface LogFields {
  context?: string;
  requestId?: string;
  userId?: string;
  route?: string;
  method?: string;
  status?: number;
  durationMs?: number;
  errorCode?: string;
  [key: string]: unknown;
}

/**
 * Structured JSON logger used as the Nest application logger. One line per event,
 * machine-parseable, with secrets redacted. `error`/`warn` go to stderr.
 */
export class AppLogger implements LoggerService {
  constructor(
    private readonly defaultContext = 'App',
    private readonly enabled: LogLevel[] = ['log', 'error', 'warn', 'debug', 'verbose'],
  ) {}

  private write(level: LogLevel, message: unknown, fields: LogFields = {}): void {
    if (!this.enabled.includes(level)) return;
    const line = {
      level,
      timestamp: new Date().toISOString(),
      context: fields.context ?? this.defaultContext,
      message: typeof message === 'string' ? message : redact(message),
      ...(redact(fields) as Record<string, unknown>),
    };
    const serialized = JSON.stringify(line);
    if (level === 'error' || level === 'warn') process.stderr.write(serialized + '\n');
    else process.stdout.write(serialized + '\n');
  }

  /** Emit an event with structured fields (preferred over string logging). */
  event(message: string, fields: LogFields): void {
    this.write(fields.status && fields.status >= 500 ? 'error' : 'log', message, fields);
  }

  log(message: unknown, context?: string): void {
    this.write('log', message, { context });
  }

  error(message: unknown, stackOrContext?: string, context?: string): void {
    this.write('error', message, {
      context: context ?? stackOrContext,
      stack: context ? stackOrContext : undefined,
    });
  }

  warn(message: unknown, context?: string): void {
    this.write('warn', message, { context });
  }

  debug(message: unknown, context?: string): void {
    this.write('debug', message, { context });
  }

  verbose(message: unknown, context?: string): void {
    this.write('verbose', message, { context });
  }
}

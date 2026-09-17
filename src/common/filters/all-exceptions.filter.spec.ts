import { HttpException, type ArgumentsHost } from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { AppException } from '../errors/app-exception';
import { ErrorCode } from '../errors/error-codes';
import { mapPostgrestError } from '../../supabase/supabase.service';
import type { AppLogger } from '../logger/app-logger';
import type { PostgrestError } from '@supabase/supabase-js';

/**
 * PHASE 14/16 (STEP 4): 5xx responses must not carry internals.
 *
 * The bug these lock down: the filter's `AppException` branch forwarded
 * `message` and `details` verbatim at every status. Because
 * `mapPostgrestError` deliberately puts the raw PostgREST sentence, the
 * SQLSTATE, the semantic `hint` and the failing RPC name into `details` (so
 * admin consoles can phrase a 4xx refusal), an *unmapped* database error —
 * which falls through to 502 — shipped all of it to the caller: the schema's
 * wording, the function name, and the provider's status code. Providers raise
 * raw upstream sentences on 5xx for the same reason.
 *
 * The 4xx half of the contract is asserted here too, because the fix must not
 * cost the admin consoles the hints they branch on (`owner_only`,
 * `rate_limited`, `superadmin_locked`, …) nor cost clients the business-rule
 * sentences that `raise exception` exists to deliver.
 */

interface Captured {
  status: number;
  body: {
    success: boolean;
    data: null;
    error: { code: string; message: string; details?: unknown };
    meta: { requestId?: string };
  };
}

/** Runs the filter against a minimal host and returns what would be written. */
function run(exception: unknown): { captured: Captured; logged: unknown[][] } {
  const captured = { status: 0, body: undefined } as unknown as Captured;
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({
        headersSent: false,
        status(code: number) {
          captured.status = code;
          return this;
        },
        json(payload: unknown) {
          captured.body = payload as Captured['body'];
        },
      }),
      getRequest: () => ({
        method: 'POST',
        originalUrl: '/api/v1/x?secret=ignored',
        esporta: { requestId: 'req-1', user: { id: 'user-1' } },
      }),
    }),
  } as unknown as ArgumentsHost;

  const logged: unknown[][] = [];
  const logger = {
    error: (...args: unknown[]) => logged.push(args),
    event: (...args: unknown[]) => logged.push(args),
  } as unknown as AppLogger;

  new AllExceptionsFilter(logger).catch(exception, host);
  return { captured, logged };
}

describe('AllExceptionsFilter — 5xx never leaks internals', () => {
  it('scrubs an unmapped database error (the 502 fallback)', () => {
    // `admin_users` is the failing RPC; XX000 is a raw Postgres SQLSTATE.
    const { captured } = run(
      mapPostgrestError(
        pg({ code: 'XX000', message: 'permission denied for table posts' }),
        'admin_users',
      ),
    );

    expect(captured.status).toBe(502);
    expect(captured.body.error.message).toBe('Something went wrong.');
    // The raw sentence, the SQLSTATE, the RPC name: none of it on the wire.
    const wire = JSON.stringify(captured.body);
    expect(wire).not.toContain('permission denied');
    expect(wire).not.toContain('XX000');
    expect(wire).not.toContain('admin_users');
    expect(captured.body.error.details).toBeUndefined();
  });

  it('scrubs a raw provider failure sentence', () => {
    const { captured } = run(AppException.upstream('R2 DELETE failed (403).'));

    expect(captured.status).toBe(502);
    expect(captured.body.error.message).toBe('Something went wrong.');
    expect(JSON.stringify(captured.body)).not.toContain('R2 DELETE failed');
  });

  it('keeps the raw message in the log even though the wire is scrubbed', () => {
    // Operators still need the real cause; only the client response is generic.
    const { captured, logged } = run(AppException.upstream('permission denied for table posts'));

    expect(captured.body.error.message).toBe('Something went wrong.');
    expect(JSON.stringify(logged)).toContain('permission denied for table posts');
  });

  it('scrubs an HttpException 5xx message and details', () => {
    const { captured } = run(
      new HttpException(
        { message: 'pg: connection terminated unexpectedly', details: { sink: 'primary' } },
        503,
      ),
    );

    expect(captured.status).toBe(503);
    expect(captured.body.error.message).toBe('Something went wrong.');
    expect(captured.body.error.details).toBeUndefined();
    expect(JSON.stringify(captured.body)).not.toContain('connection terminated');
  });

  it('scrubs an unknown throwable', () => {
    const { captured } = run(new Error('ENOENT: /var/task/src/config.ts'));

    expect(captured.status).toBe(500);
    expect(captured.body.error.message).toBe('Something went wrong.');
    expect(JSON.stringify(captured.body)).not.toContain('/var/task');
  });
});

function pg(over: Partial<PostgrestError>): PostgrestError {
  return {
    name: 'PostgrestError',
    message: 'boom',
    details: '',
    hint: '',
    code: '',
    ...over,
  } as PostgrestError;
}

describe('AllExceptionsFilter — 4xx keeps the client contract', () => {
  it('delivers a business-rule sentence verbatim (P0001)', () => {
    const { captured } = run(
      mapPostgrestError(pg({ code: 'P0001', message: 'Cannot close a filled listing.' })),
    );

    expect(captured.status).toBe(400);
    expect(captured.body.error.message).toBe('Cannot close a filled listing.');
  });

  it('keeps the generic 403 message but preserves the admin hint', () => {
    const { captured } = run(
      mapPostgrestError(
        pg({
          code: '42501',
          message: 'Only the team owner can remove an admin.',
          hint: 'owner_only',
        }),
      ),
    );

    expect(captured.status).toBe(403);
    // The raw Postgres wording stays off the wire…
    expect(captured.body.error.message).toBe('You are not allowed to do that.');
    // …while the console can still tell one refusal from another.
    expect((captured.body.error.details as { hint?: string }).hint).toBe('owner_only');
  });

  it('delivers RATE_LIMITED verbatim (the STEP 1 throttler contract)', () => {
    const { captured } = run(AppException.rateLimited());

    expect(captured.status).toBe(429);
    expect(captured.body.error.code).toBe(ErrorCode.RATE_LIMITED);
    expect(captured.body.error.message).toBe('Too many requests. Please slow down.');
  });

  it('delivers a 404 verbatim', () => {
    const { captured } = run(AppException.notFound('Not found.'));

    expect(captured.status).toBe(404);
    expect(captured.body.error.message).toBe('Not found.');
  });

  it('stamps the request id without echoing the query string', () => {
    const { captured } = run(AppException.notFound('Not found.'));

    expect(captured.body.meta.requestId).toBe('req-1');
    expect(captured.body.success).toBe(false);
    expect(captured.body.data).toBeNull();
  });
});

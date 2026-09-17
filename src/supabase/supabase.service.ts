import { Injectable } from '@nestjs/common';
import {
  createClient,
  type PostgrestError,
  type SupabaseClient,
  type User,
} from '@supabase/supabase-js';
import { AppConfigService } from '../config/app-config.service';
import { AppException } from '../common/errors/app-exception';
import { ErrorCode } from '../common/errors/error-codes';

/**
 * The one place Supabase clients are created (plan §9).
 *
 * - {@link asCaller} builds a client carrying the caller's JWT, so every read and
 *   write is still filtered by RLS and `can_act_as()`. This is the DEFAULT for
 *   anything done on behalf of a user — least privilege.
 * - {@link service} returns the cached service-role client, for genuinely
 *   actor-less work only (push dispatch, scheduled aggregation, signed-out
 *   recovery). Never reach for it just to "make a query work".
 * - {@link anon} returns the cached anon-key client — the `anon` Postgres role,
 *   with no caller at all. For `@Public()` routes serving signed-out callers.
 */
@Injectable()
export class SupabaseService {
  private readonly serviceClient: SupabaseClient;
  private readonly anonClient: SupabaseClient;

  constructor(private readonly config: AppConfigService) {
    const { url, serviceRoleKey, anonKey } = this.config.supabase;
    this.serviceClient = createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { 'X-Client-Info': 'esporta-backend/service' } },
    });
    this.anonClient = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { 'X-Client-Info': 'esporta-backend/anon' } },
    });
  }

  /** Service-role client. Actor-less privileged work ONLY. */
  service(): SupabaseClient {
    return this.serviceClient;
  }

  /**
   * Anon-key client with no caller identity — exactly the privileges a signed-out
   * app would have talking to Supabase directly. For `@Public()` routes, and only
   * where the answer does not depend on who is asking. Strictly *less* privileged
   * than {@link asCaller}, so choosing it is never an escalation.
   */
  anon(): SupabaseClient {
    return this.anonClient;
  }

  /** A client scoped to the caller's JWT — RLS applies. Built per request. */
  asCaller(accessToken: string): SupabaseClient {
    const { url, anonKey } = this.config.supabase;
    return createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'X-Client-Info': 'esporta-backend/caller',
        },
      },
    });
  }

  /**
   * Verifies a Supabase access token against gotrue and returns the user.
   * Returns null when the token is missing/invalid/expired — the caller decides
   * how to respond.
   */
  async verifyAccessToken(accessToken: string): Promise<User | null> {
    if (!accessToken) return null;
    const { data, error } = await this.serviceClient.auth.getUser(accessToken);
    if (error || !data?.user) return null;
    return data.user;
  }

  /** Calls an RPC as the caller (RLS-aware), throwing a mapped AppException on error. */
  async rpcAsCaller<T = unknown>(
    accessToken: string,
    fn: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    const { data, error } = await this.asCaller(accessToken).rpc(fn, params);
    if (error) throw mapPostgrestError(error, fn);
    return data as T;
  }

  /** Calls an RPC as `anon` — no caller. `@Public()` routes only. */
  async rpcAsAnon<T = unknown>(
    fn: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    const { data, error } = await this.anonClient.rpc(fn, params);
    if (error) throw mapPostgrestError(error, fn);
    return data as T;
  }

  /** Calls an RPC with the service role. Actor-less paths only. */
  async rpcAsService<T = unknown>(
    fn: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    const { data, error } = await this.serviceClient.rpc(fn, params);
    if (error) throw mapPostgrestError(error, fn);
    return data as T;
  }

  /**
   * Awaits a PostgREST query builder and throws a mapped {@link AppException} on
   * error, otherwise returns the data cast to `T`. Keeps table-op call sites in
   * feature services free of repetitive `{ data, error }` handling. `data` is
   * typed `unknown` so any builder result (array, single, null) is accepted.
   */
  async run<T = unknown>(
    builder: PromiseLike<{ data: unknown; error: PostgrestError | null }>,
  ): Promise<T> {
    const { data, error } = await builder;
    if (error) throw mapPostgrestError(error);
    return data as T;
  }
}

/**
 * Maps a PostgREST/Postgres error to an {@link AppException} with a sensible
 * status + code. Business RPCs use `raise exception` (SQLSTATE P0001) with a
 * user-facing message, so those surface as 400 with the message intact; RLS
 * denials and constraint violations map to 403/404/409/422.
 *
 * **The SQLSTATE and hint are preserved in `details`.** The `admin_*` RPCs
 * deliberately raise semantic hints that only they know the meaning of —
 * `superadmin_locked`, `capability_required`, `no_self_escalation`,
 * `self_escalation`, `rate_limited` — and an admin console needs them to phrase
 * the refusal correctly ("you cannot change your own admin access" is a
 * different sentence from "your role does not allow this"). Collapsing every
 * 42501 into one generic message, as this function previously did, made those
 * distinctions unrecoverable by any client. SQLSTATEs and these hints are
 * semantic markers, not internals, so passing them through leaks nothing that
 * the message did not already.
 */
export function mapPostgrestError(error: PostgrestError, fn?: string): AppException {
  const code = error.code ?? '';
  const message = error.message || 'Database request failed.';
  // Kept on every mapped error so a caller can branch on the exact SQLSTATE
  // instead of guessing from the HTTP status.
  const details = {
    ...(code ? { code } : {}),
    ...(error.hint ? { hint: error.hint } : {}),
    ...(error.message ? { message: error.message } : {}),
    ...(fn ? { fn } : {}),
  };

  switch (code) {
    case '42501': // insufficient_privilege (RLS / admin_require)
      // The CLIENT-FACING message stays generic so a normal app path cannot leak
      // "permission denied for table x". The raw sentence and the hint travel in
      // `details`, which is what an admin console reads to phrase the specific
      // refusal.
      return AppException.forbidden('You are not allowed to do that.', ErrorCode.FORBIDDEN, details);
    case 'PGRST116': // no rows returned for single()
      return AppException.notFound('Not found.', ErrorCode.NOT_FOUND, details);
    case 'P0002': // no_data_found — `select ... into strict` found nothing
      // A well-formed id that is not in the table is a 404, not a 502. Detail
      // pages depend on this to render "not found" instead of an error page.
      return AppException.notFound('Not found.', ErrorCode.NOT_FOUND, details);
    case '23505': // unique_violation
      return AppException.conflict(message, ErrorCode.CONFLICT, details);
    case '23503': // foreign_key_violation
    case '23514': // check_violation
    case '23502': // not_null_violation
      return AppException.unprocessable(message, ErrorCode.UNPROCESSABLE, details);
    case '22023': // invalid_parameter_value — an RPC rejecting an enum/argument
      return AppException.badRequest(message, ErrorCode.BAD_REQUEST, details);
    case '54000': // program_limit_exceeded — used for the announcement rate limit
      return AppException.badRequest(message, ErrorCode.BAD_REQUEST, details);
    case 'P0001': // raise exception — user-facing business rule
      return AppException.badRequest(message, ErrorCode.BAD_REQUEST, details);
    default:
      // Unknown/internal DB error: don't leak internals, but keep the fn for logs.
      return new AppException(502, ErrorCode.UPSTREAM_ERROR, message, details);
  }
}

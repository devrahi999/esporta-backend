import { mapPostgrestError } from './supabase.service';
import { ErrorCode } from '../common/errors/error-codes';
import type { PostgrestError } from '@supabase/supabase-js';

/**
 * Regression tests for the database→HTTP error contract.
 *
 * The bug these lock down: `mapPostgrestError` used to translate a Postgres
 * error into a status and then THROW AWAY the SQLSTATE and the hint. The
 * `admin_*` RPCs raise semantic hints only they know the meaning of
 * (`self_escalation`, `rate_limited`, `superadmin_locked`, …), and an admin
 * console needs them to phrase the refusal correctly — "you cannot change your
 * own admin access" is a different sentence from "your role does not allow
 * this". With the codes discarded, every refusal arrived as one generic 403 and
 * those distinctions were unrecoverable by any client.
 *
 * `P0002` was also unmapped, so a well-formed id that simply is not in the table
 * fell through to a 502 instead of a 404 — which made detail pages render an
 * error page where they should have rendered "not found".
 */

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

/** The `details` payload the filter forwards to the client as `error.details`. */
function details(e: { details?: unknown }) {
  return (e.details ?? {}) as { code?: string; hint?: string; message?: string; fn?: string };
}

describe('mapPostgrestError — status mapping', () => {
  it('maps an RLS/capability refusal to 403', () => {
    const e = mapPostgrestError(pg({ code: '42501', message: 'permission denied for function x' }));
    expect(e.getStatus()).toBe(403);
    expect(e.code).toBe(ErrorCode.FORBIDDEN);
  });

  it('maps no_data_found (P0002) to 404, not 502', () => {
    // A well-formed id that is not in the table is "not found". Detail pages
    // branch on this to call notFound() instead of showing an error page.
    const e = mapPostgrestError(pg({ code: 'P0002', message: 'query returned no rows' }));
    expect(e.getStatus()).toBe(404);
    expect(e.code).toBe(ErrorCode.NOT_FOUND);
  });

  it('maps a business-rule raise (P0001) to 400 with the message intact', () => {
    const e = mapPostgrestError(pg({ code: 'P0001', message: 'Cannot close a filled listing.' }));
    expect(e.getStatus()).toBe(400);
    expect(e.message).toBe('Cannot close a filled listing.');
  });

  it('maps an invalid enum/argument (22023) to 400', () => {
    const e = mapPostgrestError(pg({ code: '22023', message: 'not a valid status' }));
    expect(e.getStatus()).toBe(400);
  });

  it('maps the announcement rate limit (54000) to 400', () => {
    const e = mapPostgrestError(pg({ code: '54000', message: 'too many', hint: 'rate_limited' }));
    expect(e.getStatus()).toBe(400);
    expect(details(e).hint).toBe('rate_limited');
  });

  it('keeps unique/foreign-key violations on 409/422', () => {
    expect(mapPostgrestError(pg({ code: '23505', message: 'dup' })).getStatus()).toBe(409);
    expect(mapPostgrestError(pg({ code: '23503', message: 'fk' })).getStatus()).toBe(422);
  });

  it('falls back to 502 for an unrecognised database error', () => {
    const e = mapPostgrestError(pg({ code: 'XX000', message: 'internal' }), 'admin_users');
    expect(e.getStatus()).toBe(502);
    expect(details(e).fn).toBe('admin_users');
  });
});

describe('mapPostgrestError — the SQLSTATE and hint survive', () => {
  it('forwards the SQLSTATE so a client can branch on the exact code', () => {
    const e = mapPostgrestError(pg({ code: 'P0002', message: 'query returned no rows' }));
    expect(details(e).code).toBe('P0002');
  });

  it('forwards the hint that distinguishes one refusal from another', () => {
    const self = mapPostgrestError(
      pg({ code: '42501', message: 'no self escalation', hint: 'self_escalation' }),
    );
    const locked = mapPostgrestError(
      pg({ code: '42501', message: 'Super Admin always holds every capability.', hint: 'superadmin_locked' }),
    );

    expect(details(self).hint).toBe('self_escalation');
    expect(details(locked).hint).toBe('superadmin_locked');
    // Both are 403; only the hint tells them apart.
    expect(self.getStatus()).toBe(403);
    expect(locked.getStatus()).toBe(403);
  });

  it('forwards the raw sentence a protected-target refusal already phrased', () => {
    const e = mapPostgrestError(
      pg({
        code: '42501',
        message: 'A role always keeps dashboard.view.',
        hint: 'capability_required',
      }),
    );
    // The client-facing message stays generic so a normal app path cannot leak
    // "permission denied for table x" …
    expect(e.message).toBe('You are not allowed to do that.');
    // … while the finished sentence is available to a console that wants it.
    expect(details(e).message).toBe('A role always keeps dashboard.view.');
  });

  it('does not leak the raw Postgres wording as the client-facing 403 message', () => {
    const e = mapPostgrestError(pg({ code: '42501', message: 'permission denied for table posts' }));
    expect(e.message).not.toContain('permission denied');
  });

  it('omits absent fields rather than emitting empty strings', () => {
    const e = mapPostgrestError(pg({ code: '23505', message: 'dup' }));
    expect(details(e)).toEqual({ code: '23505', message: 'dup' });
    expect(details(e).hint).toBeUndefined();
  });
});

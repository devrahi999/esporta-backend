import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Opaque, tamper-evident pagination cursors for ranked slates (§20).
 *
 * WHY A SLATE CURSOR RATHER THAN A KEYSET.
 * The existing chronological feed pages with `before=<created_at>`, which is
 * stable because `created_at` never changes. A ranked ordering has no such
 * column: scores depend on features and exposures that move between requests, so
 * "give me the next 10 after score 0.63" would silently skip and repeat items as
 * soon as anything was recomputed.
 *
 * So the cursor carries the SLATE — the ordered post ids decided when the
 * session began — plus the offset reached. Page 2 is a slice of the ordering
 * page 1 already committed to, which makes pagination stable by construction:
 * page 1 consuming items cannot reshuffle page 2, and a config activation
 * mid-scroll cannot reorder a session already in flight.
 *
 * WHY SIGNED.
 * The cursor travels through the client. Unsigned, it would be a
 * client-controlled list of post ids the server then returns — a way to ask for
 * arbitrary content in ranked position, and a way to forge a ranking. The HMAC
 * makes it read-only to the client: it can hand the cursor back, and nothing
 * else. (The ids it names are still fetched through RLS, so a forged cursor
 * would not leak content even if the signature were bypassed — this is the
 * second lock, not the only one.)
 */

/** The decoded cursor payload. */
export interface SlateCursor {
  /** Schema version, so the format can change without breaking live sessions. */
  v: 1;
  /** Surface the slate belongs to. A feed cursor cannot be replayed on shorts. */
  s: string;
  /** Viewer the slate was built for. */
  u: string;
  /** The ordered post ids of the slate. */
  ids: string[];
  /** How many have already been served. */
  o: number;
  /** Config version the slate was ranked under, for traceability. */
  cv: string;
  /** Time bucket, frozen for the session so exploration stays stable. */
  tb: number;
  /** Issued-at, epoch ms — the basis for expiry. */
  iat: number;
}

/**
 * How long a slate stays valid. Long enough for a real scrolling session,
 * short enough that a resumed session gets fresh content rather than yesterday's
 * ordering.
 */
export const SLATE_TTL_MS = 30 * 60_000;

/**
 * A slate is capped so a cursor cannot grow without bound. Deep scrollers are
 * handled by issuing a NEW slate when this one is exhausted, which is also the
 * right product behaviour — a fresh slate picks up content published since.
 */
export const MAX_SLATE_SIZE = 300;

function base64UrlEncode(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

function base64UrlDecode(input: string): string {
  return Buffer.from(input, 'base64url').toString('utf8');
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/** Encodes and signs a slate cursor. */
export function encodeSlateCursor(cursor: SlateCursor, secret: string): string {
  const payload = base64UrlEncode(JSON.stringify(cursor));
  return `${payload}.${sign(payload, secret)}`;
}

export type CursorDecodeFailure =
  | 'malformed'
  | 'bad_signature'
  | 'expired'
  | 'wrong_viewer'
  | 'wrong_surface'
  | 'unsupported_version';

export type CursorDecodeResult =
  | { ok: true; cursor: SlateCursor }
  | { ok: false; reason: CursorDecodeFailure };

/**
 * Verifies and decodes a cursor.
 *
 * A rejected cursor is NOT an error the caller should surface: every failure
 * mode here (expired session, config rotation, a user switching profile) is
 * normal, and the right response is to build a fresh slate. Returning a typed
 * reason instead of throwing keeps that decision — and the metric — at the call
 * site.
 */
export function decodeSlateCursor(
  raw: string,
  secret: string,
  expect: { viewerId: string; surface: string; nowMs: number },
): CursorDecodeResult {
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return { ok: false, reason: 'malformed' };

  const payload = raw.slice(0, dot);
  const provided = raw.slice(dot + 1);
  const expected = sign(payload, secret);

  // Constant-time compare. Length is checked first because timingSafeEqual
  // throws on a length mismatch, and that throw would itself be a timing signal.
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length) return { ok: false, reason: 'bad_signature' };
  if (!timingSafeEqual(providedBuf, expectedBuf)) return { ok: false, reason: 'bad_signature' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(base64UrlDecode(payload));
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (!isSlateCursor(parsed)) return { ok: false, reason: 'malformed' };
  if (parsed.v !== 1) return { ok: false, reason: 'unsupported_version' };
  if (expect.nowMs - parsed.iat > SLATE_TTL_MS) return { ok: false, reason: 'expired' };
  // A cursor is bound to the viewer it was issued for: switching to a team
  // profile mid-scroll must build a new slate, not continue the personal one.
  if (parsed.u !== expect.viewerId) return { ok: false, reason: 'wrong_viewer' };
  if (parsed.s !== expect.surface) return { ok: false, reason: 'wrong_surface' };

  return { ok: true, cursor: parsed };
}

function isSlateCursor(value: unknown): value is SlateCursor {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.v === 'number' &&
    typeof c.s === 'string' &&
    typeof c.u === 'string' &&
    Array.isArray(c.ids) &&
    c.ids.every((id) => typeof id === 'string') &&
    typeof c.o === 'number' &&
    typeof c.cv === 'string' &&
    typeof c.tb === 'number' &&
    typeof c.iat === 'number'
  );
}

/**
 * Builds the cursor for the NEXT page, or null when the slate is exhausted.
 *
 * Null is the signal to the caller that there is no more of this slate — the
 * client stops, or a refresh builds a new one. `iat` is preserved, not refreshed,
 * so a session cannot be extended indefinitely by paging.
 */
export function advanceCursor(cursor: SlateCursor, consumed: number): SlateCursor | null {
  const offset = cursor.o + consumed;
  if (offset >= cursor.ids.length) return null;
  return { ...cursor, o: offset };
}

/** The page of ids starting at the cursor's offset. */
export function pageFromCursor(cursor: SlateCursor, limit: number): string[] {
  return cursor.ids.slice(cursor.o, cursor.o + Math.max(1, limit));
}

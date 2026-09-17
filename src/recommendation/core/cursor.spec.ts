import {
  SLATE_TTL_MS,
  advanceCursor,
  decodeSlateCursor,
  encodeSlateCursor,
  pageFromCursor,
} from './cursor';

/**
 * Slate-cursor tests (§20, §26). The cursor is the piece of pagination the
 * CLIENT holds, so its integrity properties are security properties: a forged
 * cursor must be rejected, and a legitimate one must never silently reorder.
 */
const SECRET = 'test-secret';
const NOW = Date.parse('2026-09-06T12:00:00Z');
const VIEWER = '11111111-1111-1111-1111-111111111111';
const OTHER_VIEWER = '22222222-2222-2222-2222-222222222222';

function makeCursor(overrides: Partial<Parameters<typeof encodeSlateCursor>[0]> = {}) {
  return {
    v: 1 as const,
    s: 'feed',
    u: VIEWER,
    ids: ['a', 'b', 'c', 'd', 'e'],
    o: 0,
    cv: 'cfg-1',
    tb: 42,
    iat: NOW,
    ...overrides,
  };
}

describe('round trip', () => {
  it('decodes what it encodes', () => {
    const cursor = makeCursor();
    const decoded = decodeSlateCursor(encodeSlateCursor(cursor, SECRET), SECRET, {
      viewerId: VIEWER,
      surface: 'feed',
      nowMs: NOW + 1000,
    });
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.cursor).toEqual(cursor);
  });
});

describe('tamper resistance (§26)', () => {
  it('rejects a mutated payload with a valid-looking signature', () => {
    const raw = encodeSlateCursor(makeCursor(), SECRET);
    const [payload, sig] = raw.split('.');
    // Flip one character of the payload: ids, offset, viewer — anything.
    const tampered = `${payload.slice(0, -1)}${payload.slice(-1) === 'A' ? 'B' : 'A'}.${sig}`;
    const decoded = decodeSlateCursor(tampered, SECRET, {
      viewerId: VIEWER,
      surface: 'feed',
      nowMs: NOW + 1000,
    });
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.reason).toBe('bad_signature');
  });

  it('rejects a signature made with a different secret', () => {
    const raw = encodeSlateCursor(makeCursor(), SECRET);
    const decoded = decodeSlateCursor(raw, 'other-secret', {
      viewerId: VIEWER,
      surface: 'feed',
      nowMs: NOW + 1000,
    });
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.reason).toBe('bad_signature');
  });

  it('rejects garbage without throwing', () => {
    expect(decodeSlateCursor('nonsense', SECRET, {
      viewerId: VIEWER,
      surface: 'feed',
      nowMs: NOW,
    }).ok).toBe(false);
    expect(decodeSlateCursor('', SECRET, {
      viewerId: VIEWER,
      surface: 'feed',
      nowMs: NOW,
    }).ok).toBe(false);
    expect(decodeSlateCursor('a.b.c', SECRET, {
      viewerId: VIEWER,
      surface: 'feed',
      nowMs: NOW,
    }).ok).toBe(false);
  });

  it('rejects a valid JSON payload with no signature at all', () => {
    const payload = Buffer.from(JSON.stringify(makeCursor()), 'utf8').toString('base64url');
    const decoded = decodeSlateCursor(payload, SECRET, {
      viewerId: VIEWER,
      surface: 'feed',
      nowMs: NOW + 1000,
    });
    expect(decoded.ok).toBe(false);
  });
});

describe('session binding', () => {
  it('refuses a cursor minted for a different viewer', () => {
    const raw = encodeSlateCursor(makeCursor(), SECRET);
    const decoded = decodeSlateCursor(raw, SECRET, {
      viewerId: OTHER_VIEWER,
      surface: 'feed',
      nowMs: NOW + 1000,
    });
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.reason).toBe('wrong_viewer');
  });

  it('refuses a cursor minted for a different surface', () => {
    const raw = encodeSlateCursor(makeCursor(), SECRET);
    const decoded = decodeSlateCursor(raw, SECRET, {
      viewerId: VIEWER,
      surface: 'shorts',
      nowMs: NOW + 1000,
    });
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.reason).toBe('wrong_surface');
  });

  it('expires after the TTL — an old session builds a fresh slate', () => {
    const raw = encodeSlateCursor(makeCursor(), SECRET);
    const decoded = decodeSlateCursor(raw, SECRET, {
      viewerId: VIEWER,
      surface: 'feed',
      nowMs: NOW + SLATE_TTL_MS + 1,
    });
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.reason).toBe('expired');
  });

  it('is still valid just inside the TTL', () => {
    const raw = encodeSlateCursor(makeCursor(), SECRET);
    const decoded = decodeSlateCursor(raw, SECRET, {
      viewerId: VIEWER,
      surface: 'feed',
      nowMs: NOW + SLATE_TTL_MS - 1,
    });
    expect(decoded.ok).toBe(true);
  });
});

describe('pagination stability (§20)', () => {
  it('pages through the slate in the committed order without gaps or repeats', () => {
    const ids = Array.from({ length: 25 }, (_, i) => `post-${i}`);
    let cursor = makeCursor({ ids });
    const seen: string[] = [];

    while (true) {
      const page = pageFromCursor(cursor, 10);
      seen.push(...page);
      const next = advanceCursor(cursor, page.length);
      if (!next) break;
      cursor = next;
    }

    expect(seen).toEqual(ids);
  });

  it('never serves a partially-consumed page twice', () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const cursor = makeCursor({ ids, o: 10 });
    const page = pageFromCursor(cursor, 10);
    expect(page).toEqual([]);
    expect(advanceCursor(cursor, page.length)).toBeNull();
  });

  it('preserves iat while advancing, so a session cannot extend itself forever', () => {
    const ids = Array.from({ length: 25 }, (_, i) => `post-${i}`);
    const first = makeCursor({ ids, iat: NOW });
    const second = advanceCursor(first, 10)!;
    expect(second.iat).toBe(NOW);
    expect(second.o).toBe(10);
  });
});

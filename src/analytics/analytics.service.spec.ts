import { AnalyticsService } from './analytics.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type { AnalyticsEventDto } from './dto/analytics.dto';

/**
 * Regression tests for INGESTION (Analytics Part 1).
 *
 * The bug these lock down: ingestion used a PostgREST table upsert with
 * `onConflict: 'client_event_id'`, which Postgres refused outright —
 * `42P10 there is no unique or exclusion constraint matching the ON CONFLICT
 * specification`, because the guarantee was a PARTIAL unique index and a bare
 * column list can never infer one. Every single request failed, so the ledger
 * stayed empty and Parts 2-4 had nothing to read. Two further walls stood
 * behind it: naming a conflict target needs SELECT on the arbiter column, and
 * `RETURNING` needs SELECT too — both revoked from clients on purpose.
 *
 * Ingestion therefore goes through `analytics_ingest_events`, and the tests
 * below pin the properties that made that the right shape: the whole batch is
 * one call, duplicate suppression is the database's answer rather than a count
 * inferred in Node, the actor is never sent in the payload, and one invalid
 * event refuses the batch before the database is touched at all.
 */

const TOKEN = 'jwt-token';
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ME = '11111111-1111-4111-8111-111111111111';
const TEAM = '22222222-2222-4222-8222-222222222222';
const POST = '33333333-3333-4333-8333-333333333333';

const EVENT_A = '44444444-4444-4444-8444-444444444444';
const EVENT_B = '55555555-5555-4555-8555-555555555555';

interface Call {
  token: string;
  fn: string;
  params: Record<string, unknown>;
}

/**
 * A stand-in for the database that really implements the dedupe contract:
 * `on conflict (client_event_id) do nothing` over one statement. It remembers
 * every client id it has stored, and — like Postgres — treats a duplicate that
 * appears twice inside a single batch as one row while leaving rows without a
 * client id untouched. Tests can therefore assert observable ingest results
 * rather than restating the service's own arithmetic.
 */
function makeService(): {
  service: AnalyticsService;
  calls: Call[];
  stored: Array<Record<string, unknown>>;
} {
  const calls: Call[] = [];
  const stored: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();

  const supabase = {
    rpcAsCaller: async (token: string, fn: string, params: Record<string, unknown>) => {
      calls.push({ token, fn, params });
      const events = params.p_events as Array<Record<string, unknown>>;
      let ingested = 0;
      for (const event of events) {
        const id = event.event_id as string | null;
        if (id !== null && seen.has(id)) continue;
        if (id !== null) seen.add(id);
        stored.push({ ...event, actor_identity_id: params.p_identity_id });
        ingested++;
      }
      return { received: events.length, ingested, duplicates: events.length - ingested };
    },
    // The raw ledger is insert-only for clients; a table path is exactly the
    // regression this suite exists to prevent, so touching one fails loudly.
    asCaller: () => {
      throw new Error('ingestion must not touch analytics_events directly');
    },
    service: () => {
      throw new Error('ingestion must not use the service role');
    },
    run: () => {
      throw new Error('ingestion must not run a table query');
    },
  } as unknown as SupabaseService;

  return { service: new AnalyticsService(supabase), calls, stored };
}

/** A valid content event. `event_id` omitted means the client sent none. */
function postView(eventId?: string): AnalyticsEventDto {
  return {
    name: 'post_view',
    entity_type: 'post',
    entity_id: POST,
    ...(eventId ? { event_id: eventId } : {}),
    properties: { source: 'feed' },
    session_id: 'session-1',
    platform: 'android',
    app_version: '1.0.0',
  };
}

/** A session-level event: no entity, and the taxonomy forbids one. */
function appOpen(eventId?: string): AnalyticsEventDto {
  return {
    name: 'app_open',
    ...(eventId ? { event_id: eventId } : {}),
    session_id: 'session-1',
    platform: 'android',
  };
}

describe('ingestion', () => {
  it('sends one batch call and reports the database answer', async () => {
    const { service, calls, stored } = makeService();

    const result = await service.ingest(TOKEN, USER, ME, [postView(EVENT_A), appOpen(EVENT_B)]);

    expect(result).toEqual({ received: 2, ingested: 2, duplicates: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0].fn).toBe('analytics_ingest_events');
    expect(calls[0].token).toBe(TOKEN);
    expect(stored).toHaveLength(2);
  });

  it('attributes events to the acting identity and never sends the actor', async () => {
    const { service, calls } = makeService();

    await service.ingest(TOKEN, USER, TEAM, [postView(EVENT_A)]);

    expect(calls[0].params.p_identity_id).toBe(TEAM);
    // `actor_user_id` comes from auth.uid() inside the function. A payload that
    // carried it would be a spoofing surface.
    expect(JSON.stringify(calls[0].params.p_events)).not.toContain(USER);
    expect(calls[0].params.p_events).toEqual([
      {
        name: 'post_view',
        entity_type: 'post',
        entity_id: POST,
        event_id: EVENT_A,
        properties: { source: 'feed' },
        session_id: 'session-1',
        platform: 'android',
        app_version: '1.0.0',
      },
    ]);
  });

  it('passes an absent identity through as null rather than omitting it', async () => {
    const { service, calls } = makeService();

    await service.ingest(TOKEN, USER, undefined, [appOpen(EVENT_A)]);

    expect(calls[0].params.p_identity_id).toBeNull();
  });

  it('stores a retried event once', async () => {
    const { service, stored } = makeService();

    const first = await service.ingest(TOKEN, USER, ME, [postView(EVENT_A)]);
    const retry = await service.ingest(TOKEN, USER, ME, [postView(EVENT_A)]);

    expect(first).toEqual({ received: 1, ingested: 1, duplicates: 0 });
    expect(retry).toEqual({ received: 1, ingested: 0, duplicates: 1 });
    expect(stored).toHaveLength(1);
  });

  it('stores distinct event ids separately', async () => {
    const { service, stored } = makeService();

    const result = await service.ingest(TOKEN, USER, ME, [postView(EVENT_A), postView(EVENT_B)]);

    expect(result).toEqual({ received: 2, ingested: 2, duplicates: 0 });
    expect(stored).toHaveLength(2);
  });

  it('collapses a duplicate repeated inside one batch', async () => {
    const { service, stored } = makeService();

    const result = await service.ingest(TOKEN, USER, ME, [postView(EVENT_A), postView(EVENT_A)]);

    expect(result).toEqual({ received: 2, ingested: 1, duplicates: 1 });
    expect(stored).toHaveLength(1);
  });

  it('ingests the new events in a partially-retried batch', async () => {
    const { service, stored } = makeService();

    await service.ingest(TOKEN, USER, ME, [postView(EVENT_A)]);
    const mixed = await service.ingest(TOKEN, USER, ME, [postView(EVENT_A), postView(EVENT_B)]);

    expect(mixed).toEqual({ received: 2, ingested: 1, duplicates: 1 });
    expect(stored).toHaveLength(2);
  });

  it('keeps every event that carries no client id', async () => {
    const { service, stored } = makeService();

    const result = await service.ingest(TOKEN, USER, ME, [appOpen(), appOpen()]);

    expect(result).toEqual({ received: 2, ingested: 2, duplicates: 0 });
    expect(stored).toHaveLength(2);
    expect(stored.every((row) => row.event_id === null)).toBe(true);
  });

  it('deduplicates session events like any other event', async () => {
    const { service, stored } = makeService();

    await service.ingest(TOKEN, USER, ME, [appOpen(EVENT_A)]);
    const retry = await service.ingest(TOKEN, USER, ME, [appOpen(EVENT_A)]);

    expect(retry).toEqual({ received: 1, ingested: 0, duplicates: 1 });
    expect(stored).toHaveLength(1);
  });
});

describe('validation', () => {
  it('refuses the whole batch without touching the database', async () => {
    const { service, calls } = makeService();
    const events = [postView(EVENT_A), { name: 'not_an_event' } as AnalyticsEventDto];

    await expect(service.ingest(TOKEN, USER, ME, events)).rejects.toMatchObject({
      status: 400,
      details: { index: 1 },
    });
    expect(calls).toHaveLength(0);
  });

  it('refuses a session event that carries an entity', async () => {
    const { service, calls } = makeService();
    const events = [{ ...appOpen(EVENT_A), entity_type: 'post', entity_id: POST }];

    await expect(service.ingest(TOKEN, USER, ME, events)).rejects.toMatchObject({ status: 400 });
    expect(calls).toHaveLength(0);
  });
});

describe('rate limiting', () => {
  it('refuses more than 60 requests a minute', async () => {
    const { service } = makeService();

    for (let i = 0; i < 60; i++) {
      await service.ingest(TOKEN, USER, ME, [appOpen()]);
    }

    await expect(service.ingest(TOKEN, USER, ME, [appOpen()])).rejects.toMatchObject({
      status: 429,
    });
  });

  it('refuses a batch that would cross the per-minute event ceiling', async () => {
    const { service } = makeService();
    const batch = Array.from({ length: 50 }, () => appOpen());

    for (let i = 0; i < 12; i++) {
      await service.ingest(TOKEN, USER, ME, batch);
    }

    await expect(service.ingest(TOKEN, USER, ME, [appOpen()])).rejects.toMatchObject({
      status: 429,
    });
  });

  it('counts each user separately', async () => {
    const { service } = makeService();
    const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

    for (let i = 0; i < 60; i++) {
      await service.ingest(TOKEN, USER, ME, [appOpen()]);
    }

    await expect(service.ingest(TOKEN, other, ME, [appOpen()])).resolves.toMatchObject({
      ingested: 1,
    });
  });
});

/**
 * Characterization test: the exact shape of the GET /healthz payload.
 *
 * The health endpoint is the contract every hook, CLI and dashboard
 * depends on, so the whole JSON body (keys, order and values) is pinned
 * here. The daemon runs without the optional semantic stack by default,
 * in which case `index.ready` is false and `index.model` is null.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/http/app.js';
import { createRuntimeContext, type RuntimeContext } from '../../src/runtime/context.js';
import { cardInput, createTestDb, type TestDb } from '../test-utils.js';

/** Loopback env: the Host check fails closed without socket info. */
const LOCAL_ENV = { incoming: { socket: { remoteAddress: '127.0.0.1' } } };

const VERSION = '1.2.3-test';
const PID = 4242;

/** The full health payload as it is delivered over the wire. */
interface HealthBody {
  readonly app: string;
  readonly pid: number;
  readonly uptime: number;
  readonly version: string;
  readonly cards: {
    readonly total: number;
    readonly active: number;
    readonly pending_index: number;
  };
  readonly queue: {
    readonly pending_events: number;
    readonly oldest_unindexed_age_s: number;
  };
  readonly index: { readonly ready: boolean; readonly model: string | null };
}

describe('GET /healthz shape', () => {
  let t: TestDb;
  let context: RuntimeContext;
  let requestShutdown: ReturnType<typeof vi.fn>;

  function app() {
    return createApp({
      context,
      token: 'healthz-token',
      version: VERSION,
      pid: PID,
      startedAt: Date.now() - 5_000,
      requestShutdown,
    });
  }

  async function health(): Promise<HealthBody> {
    const response = await app().request(
      '/healthz',
      { headers: { host: '127.0.0.1:7800' } },
      LOCAL_ENV
    );
    expect(response.status).toBe(200);
    return (await response.json()) as HealthBody;
  }

  beforeEach(() => {
    t = createTestDb();
    context = createRuntimeContext({ db: t.db });
    requestShutdown = vi.fn();
  });

  afterEach(() => {
    t.close();
  });

  it('returns the full payload for an empty database', async () => {
    const body = await health();
    expect(body).toEqual({
      app: 'memhub',
      pid: PID,
      uptime: expect.any(Number),
      version: VERSION,
      cards: { total: 0, active: 0, pending_index: 0 },
      queue: { pending_events: 0, oldest_unindexed_age_s: 0 },
      index: { ready: false, model: null },
    });
  });

  it('keeps the documented key order', async () => {
    const response = await app().request(
      '/healthz',
      { headers: { host: '127.0.0.1:7800' } },
      LOCAL_ENV
    );
    const raw = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(raw)).toEqual([
      'app',
      'pid',
      'uptime',
      'version',
      'cards',
      'queue',
      'index',
    ]);
    expect(Object.keys(raw.cards as object)).toEqual(['total', 'active', 'pending_index']);
    expect(Object.keys(raw.queue as object)).toEqual(['pending_events', 'oldest_unindexed_age_s']);
    expect(Object.keys(raw.index as object)).toEqual(['ready', 'model']);
  });

  it('reports a non-negative uptime', async () => {
    const body = await health();
    expect(body.uptime).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(body.uptime)).toBe(true);
  });

  it('counts cards, queue events and the pending index', async () => {
    t.cards.createCard(cardInput({ title: 'one', body: 'first card' }));
    t.cards.createCard(cardInput({ title: 'two', body: 'second card' }));

    const body = await health();
    expect(body).toEqual({
      app: 'memhub',
      pid: PID,
      uptime: expect.any(Number),
      version: VERSION,
      cards: { total: 2, active: 2, pending_index: 2 },
      queue: { pending_events: 2, oldest_unindexed_age_s: expect.any(Number) },
      index: { ready: false, model: null },
    });
    expect(body.queue.oldest_unindexed_age_s).toBeGreaterThanOrEqual(0);
  });

  it('does not report ready while cards wait for the index', async () => {
    t.cards.createCard(cardInput({ title: 'one', body: 'first card' }));
    t.db.prepare("INSERT INTO worker_state(key, value) VALUES ('indexer.model', 'mini-lm')").run();

    const body = await health();
    // The model is known, but the pending card keeps the index not ready.
    expect(body.index).toEqual({ ready: false, model: 'mini-lm' });
    expect(body.cards.pending_index).toBe(1);
  });

  it('reports ready when a model is recorded and nothing is pending', async () => {
    t.db.prepare("INSERT INTO worker_state(key, value) VALUES ('indexer.model', 'mini-lm')").run();

    const body = await health();
    expect(body.index).toEqual({ ready: true, model: 'mini-lm' });
    expect(body.cards.pending_index).toBe(0);
  });

  it('does not count archived cards as active', async () => {
    const created = t.cards.createCard(cardInput({ title: 'one', body: 'first card' }));
    t.cards.archiveCard(created.id);

    const body = await health();
    expect(body.cards).toEqual({ total: 1, active: 0, pending_index: 0 });
  });
});

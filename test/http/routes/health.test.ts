import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerHealthRoutes } from '../../../src/http/routes/health.js';
import { bareApp, createRouteFixture, type RouteFixture } from './helpers.js';

describe('registerHealthRoutes', () => {
  let fixture: RouteFixture;

  function app(): ReturnType<typeof bareApp> {
    const instance = bareApp();
    registerHealthRoutes(instance, {
      context: fixture.context,
      version: '1.2.3-test',
      pid: 4242,
      startedAt: Date.now() - 5000,
    });
    return instance;
  }

  beforeEach(() => {
    fixture = createRouteFixture();
  });

  afterEach(() => {
    fixture.close();
  });

  it('answers with the counters of the process', async () => {
    const response = await app().request('/healthz');
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      app: string;
      pid: number;
      uptime: number;
      version: string;
      cards: { total: number; active: number; pending_index: number };
      queue: { pending_events: number; oldest_unindexed_age_s: number };
      index: { ready: boolean; model: string | null };
    };
    expect(body.app).toBe('memhub');
    expect(body.pid).toBe(4242);
    expect(body.uptime).toBeGreaterThanOrEqual(5);
    expect(body.version).toBe('1.2.3-test');
    expect(body.cards).toEqual({ total: 0, active: 0, pending_index: 0 });
    expect(body.queue.pending_events).toBe(0);
    expect(body.index).toEqual({ ready: false, model: null });
  });

  it('reports the index as ready once a model is recorded', async () => {
    fixture.db.prepare("INSERT INTO worker_state(key, value) VALUES ('indexer.model', 'm')").run();
    const body = (await (await app().request('/healthz')).json()) as {
      index: { ready: boolean; model: string | null };
    };
    expect(body.index).toEqual({ ready: true, model: 'm' });
  });
});

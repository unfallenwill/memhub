import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerQueueRoutes } from '../../../src/http/routes/queue.js';
import { bareApp, createRouteFixture, jsonRequest, type RouteFixture } from './helpers.js';

describe('registerQueueRoutes', () => {
  let fixture: RouteFixture;

  function app(): ReturnType<typeof bareApp> {
    const instance = bareApp();
    registerQueueRoutes(instance, { context: fixture.context });
    return instance;
  }

  beforeEach(() => {
    fixture = createRouteFixture();
  });

  afterEach(() => {
    fixture.close();
  });

  it('reports the event queue and the index backlog', async () => {
    fixture.context.cards.createCard({
      title: 'T',
      body: 'B',
      type: 'fact',
      cues: [],
      confidence: 0.5,
    });
    const response = await jsonRequest(app(), '/api/queue');
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      pending_events: number;
      oldest_unprocessed_event_age_s: number;
      pending_index: number;
      oldest_unindexed_age_s: number;
    };
    expect(body.pending_events).toBe(1);
    expect(body.pending_index).toBe(1);
    expect(body.oldest_unprocessed_event_age_s).toBeGreaterThanOrEqual(0);
    expect(body.oldest_unindexed_age_s).toBeGreaterThanOrEqual(0);
  });
});

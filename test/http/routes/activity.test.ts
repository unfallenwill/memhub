import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerActivityRoutes } from '../../../src/http/routes/activity.js';
import { bareApp, createRouteFixture, jsonRequest, type RouteFixture } from './helpers.js';

describe('registerActivityRoutes', () => {
  let fixture: RouteFixture;

  function app(): ReturnType<typeof bareApp> {
    const instance = bareApp();
    registerActivityRoutes(instance, { context: fixture.context });
    return instance;
  }

  beforeEach(() => {
    fixture = createRouteFixture();
  });

  afterEach(() => {
    fixture.close();
  });

  it('lists the entries newest first with the cursor of the last one', async () => {
    for (const title of ['a', 'b', 'c']) {
      fixture.context.cards.createCard({
        title,
        body: 'B',
        type: 'fact',
        cues: [],
        confidence: 0.5,
      });
    }
    const response = await jsonRequest(app(), '/api/activity?limit=2');
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      entries: { id: number; actor: string; action: string; card_id: number }[];
      next_cursor: number;
    };
    expect(body.entries).toHaveLength(2);
    expect(body.entries[0].actor).toBe('hook');
    expect(body.entries[0].action).toBe('card.created');
    expect(body.next_cursor).toBe(body.entries[1].id);
  });

  it('rejects a malformed cursor or limit with 400', async () => {
    expect((await jsonRequest(app(), '/api/activity?cursor=nope')).status).toBe(400);
    expect((await jsonRequest(app(), '/api/activity?limit=0')).status).toBe(400);
  });
});

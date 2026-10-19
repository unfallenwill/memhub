import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CardRepository } from '../../../src/core/ports/repositories.js';
import { registerCardRoutes } from '../../../src/http/routes/cards.js';
import { CardService } from '../../../src/services/card-service.js';
import { bareApp, createRouteFixture, jsonRequest, type RouteFixture } from './helpers.js';

describe('registerCardRoutes', () => {
  let fixture: RouteFixture;

  function app(): ReturnType<typeof bareApp> {
    const instance = bareApp();
    registerCardRoutes(instance, { context: fixture.context });
    return instance;
  }

  beforeEach(() => {
    fixture = createRouteFixture();
  });

  afterEach(() => {
    fixture.close();
  });

  it('creates a card and answers 202 with the write result', async () => {
    const response = await jsonRequest(app(), '/api/cards', {
      method: 'POST',
      body: JSON.stringify({ title: 'T', body: 'B', type: 'fact' }),
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ id: 1, indexed: false, deduplicated: false });
  });

  it('lists the cards newest first with a cursor', async () => {
    for (const title of ['one', 'two']) {
      await jsonRequest(app(), '/api/cards', {
        method: 'POST',
        body: JSON.stringify({ title, body: 'B', type: 'fact' }),
      });
    }
    const response = await jsonRequest(app(), '/api/cards?limit=1');
    const body = (await response.json()) as {
      cards: { id: number }[];
      next_cursor: number | null;
    };
    expect(body.cards.map(c => c.id)).toEqual([2]);
    expect(body.next_cursor).toBe(2);
  });

  it('reads, updates and archives a card', async () => {
    await jsonRequest(app(), '/api/cards', {
      method: 'POST',
      body: JSON.stringify({ title: 'T', body: 'B', type: 'fact' }),
    });
    const read = await jsonRequest(app(), '/api/cards/1');
    expect(read.status).toBe(200);
    expect(((await read.json()) as { card: { id: number } }).card.id).toBe(1);

    const patched = await jsonRequest(app(), '/api/cards/1', {
      method: 'PATCH',
      body: JSON.stringify({ title: 'new' }),
    });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { card: { title: string } }).card.title).toBe('new');

    const deleted = await jsonRequest(app(), '/api/cards/1', { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    expect(((await deleted.json()) as { card: { status: string } }).card.status).toBe('archived');
  });

  it('supersedes a card and records the successor', async () => {
    for (const title of ['old', 'new']) {
      await jsonRequest(app(), '/api/cards', {
        method: 'POST',
        body: JSON.stringify({ title, body: 'B', type: 'fact' }),
      });
    }
    const response = await jsonRequest(app(), '/api/cards/1/invalidate', {
      method: 'POST',
      body: JSON.stringify({ card_id: 2 }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { card: { status: string; superseded_by: number } };
    expect(body.card.status).toBe('superseded');
    expect(body.card.superseded_by).toBe(2);
  });

  it('rejects a self-supersede and an unknown successor with 400', async () => {
    await jsonRequest(app(), '/api/cards', {
      method: 'POST',
      body: JSON.stringify({ title: 'T', body: 'B', type: 'fact' }),
    });
    for (const body of [{ card_id: 1 }, { card_id: 99 }]) {
      const response = await jsonRequest(app(), '/api/cards/1/invalidate', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      const error = (await response.json()) as { error: { code: string } };
      expect(error.error.code).toBe('invalid_request');
    }
  });

  it('answers 404 for unknown cards and 400 for malformed ids', async () => {
    expect((await jsonRequest(app(), '/api/cards/99')).status).toBe(404);
    expect((await jsonRequest(app(), '/api/cards/abc')).status).toBe(400);
  });

  it('rethrows unexpected store errors instead of masking them', async () => {
    // A store failure that is not a supersede-target problem must not be
    // reported as a bad request.
    const exploding: CardRepository = new Proxy(fixture.context.cards, {
      get(target, prop) {
        if (prop === 'invalidateCard') {
          return (): never => {
            throw new Error('store exploded');
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await jsonRequest(app(), '/api/cards', {
      method: 'POST',
      body: JSON.stringify({ title: 'T', body: 'B', type: 'fact' }),
    });
    const instance = bareApp();
    registerCardRoutes(instance, {
      context: {
        ...fixture.context,
        cardService: new CardService({
          cards: exploding,
          events: fixture.context.events,
          activity: fixture.context.activity,
        }),
      },
    });

    const response = await jsonRequest(instance, '/api/cards/1/invalidate', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('internal_error');
  });

  it('answers 400 with the domain message when the successor does not exist', async () => {
    await jsonRequest(app(), '/api/cards', {
      method: 'POST',
      body: JSON.stringify({ title: 'T', body: 'B', type: 'fact' }),
    });
    const response = await jsonRequest(app(), '/api/cards/1/invalidate', {
      method: 'POST',
      body: JSON.stringify({ card_id: 99 }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('invalid_request');
    expect(body.error.message).toBe('superseded_by target card 99 does not exist');
  });
});

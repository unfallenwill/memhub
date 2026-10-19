/**
 * The supersede route of the card endpoints
 * (src/http/routes/cards.ts).
 *
 * Invalidating a card that is not there is a 404, not a silent success
 * and not a 400.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerCardRoutes } from '../../../src/http/routes/cards.js';
import { bareApp, createRouteFixture, jsonRequest, type RouteFixture } from './helpers.js';

describe('invalidating a card that does not exist', () => {
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

  it('answers 404 when the card to supersede is unknown', async () => {
    const response = await jsonRequest(app(), '/api/cards/4242/invalidate', {
      method: 'POST',
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('not_found');
    expect(body.error.message).toContain('card 4242 not found');
  });
});

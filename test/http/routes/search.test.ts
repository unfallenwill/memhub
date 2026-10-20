import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SearchService } from '../../../src/services/search-service.js';
import { registerSearchRoutes } from '../../../src/http/routes/search.js';
import { bareApp, createRouteFixture, jsonRequest, type RouteFixture } from './helpers.js';

describe('registerSearchRoutes', () => {
  let fixture: RouteFixture;

  function app(): ReturnType<typeof bareApp> {
    const instance = bareApp();
    registerSearchRoutes(instance, { context: fixture.context });
    return instance;
  }

  beforeEach(() => {
    fixture = createRouteFixture();
    fixture.context.cards.createCard({
      title: 'docker deploy',
      body: 'containers everywhere',
      type: 'pattern',
      cues: ['ops'],
      confidence: 0.5,
    });
  });

  afterEach(() => {
    fixture.close();
  });

  it('answers with the matches, their score and how they matched', async () => {
    const response = await jsonRequest(app(), '/api/search', {
      method: 'POST',
      body: JSON.stringify({ query: 'docker' }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      results: { id: number; score: number; matched_by: string }[];
      mode_used: string;
    };
    expect(body.mode_used).toBe('keyword');
    expect(body.results).toHaveLength(1);
    expect(body.results[0].id).toBe(1);
    expect(body.results[0].matched_by).toBe('fts');
    expect(typeof body.results[0].score).toBe('number');
  });

  it('answers 503 when the semantic index is not ready', async () => {
    const response = await jsonRequest(app(), '/api/search', {
      method: 'POST',
      body: JSON.stringify({ query: 'x', mode: 'semantic' }),
    });
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('index_not_ready');
  });

  it('rejects invalid search payloads with 400', async () => {
    for (const payload of [{}, { query: '' }, { query: 'x', mode: 'bogus' }]) {
      const response = await jsonRequest(app(), '/api/search', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      expect(response.status).toBe(400);
    }
  });

  it('rethrows unexpected search errors instead of masking them', async () => {
    const exploding: SearchService = new Proxy(fixture.context.search, {
      get(target, prop) {
        if (prop === 'search') {
          return async (): Promise<never> => {
            throw new Error('search exploded');
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const instance = bareApp();
    registerSearchRoutes(instance, { context: { ...fixture.context, search: exploding } });

    const response = await jsonRequest(instance, '/api/search', {
      method: 'POST',
      body: JSON.stringify({ query: 'x' }),
    });
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('internal_error');
  });
});

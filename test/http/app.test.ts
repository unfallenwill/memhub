import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hono } from 'hono';
import { createApp } from '../../src/http/app.js';
import { SemanticSearch } from '../../src/services/semantic-search.js';
import {
  createTestDb,
  deterministicVector,
  FakeEmbedder,
  FakeVectorStore,
  type TestDb,
} from '../test-utils.js';

const TOKEN = 'test-token';

describe('HTTP app', () => {
  let t: TestDb;
  let db: DatabaseSync;
  let requestShutdown: ReturnType<typeof vi.fn>;

  function app() {
    return createApp({
      db,
      token: TOKEN,
      version: '1.2.3-test',
      pid: 4242,
      startedAt: Date.now() - 5000,
      requestShutdown,
    });
  }

  function appWithSemantic(semantic: SemanticSearch): Hono {
    return createApp({
      db,
      token: TOKEN,
      version: '1.2.3-test',
      pid: 4242,
      startedAt: Date.now() - 5000,
      requestShutdown,
      semantic,
    });
  }

  function authed(init: RequestInit = {}): RequestInit {
    return { ...init, headers: { 'x-memhub-token': TOKEN, ...init.headers } };
  }

  /**
   * Perform an in-memory request. Sets a local Host header by default
   * (real HTTP clients always send one; undici's Request does not).
   */
  function request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = {
      host: '127.0.0.1:7800',
      ...((init.headers as Record<string, string>) ?? {}),
    };
    return app().request(path, { ...init, headers });
  }

  /** Like request(), but with extra allowed hosts injected (cloud setup). */
  function requestWithHosts(
    path: string,
    allowedHosts: readonly string[],
    init: RequestInit = {}
  ): Promise<Response> {
    const headers = {
      host: '127.0.0.1:7800',
      ...((init.headers as Record<string, string>) ?? {}),
    };
    return createApp({
      db,
      token: TOKEN,
      version: '1.2.3-test',
      pid: 4242,
      startedAt: Date.now(),
      requestShutdown,
      allowedHosts,
    }).request(path, { ...init, headers });
  }

  beforeEach(() => {
    t = createTestDb();
    db = t.db;
    requestShutdown = vi.fn();
  });

  afterEach(() => {
    t.close();
  });

  describe('security middleware', () => {
    it('rejects non-local Host headers with 403', async () => {
      const response = await request('/healthz', { headers: { host: 'evil.example' } });
      expect(response.status).toBe(403);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('invalid_host');
    });

    it('rejects a missing Host header', async () => {
      const response = await request('http://localhost:7800/healthz', {
        headers: { host: '' },
      });
      expect(response.status).toBe(403);
    });

    it('requires X-Memhub-Token on /api/* routes', async () => {
      const response = await request('/api/cards');
      expect(response.status).toBe(401);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('unauthorized');
    });

    it('rejects a wrong token', async () => {
      const response = await request('/api/cards', {
        headers: { 'x-memhub-token': 'wrong' },
      });
      expect(response.status).toBe(401);
    });

    it('serves /healthz without a token', async () => {
      const response = await request('/healthz');
      expect(response.status).toBe(200);
    });

    it('allows localhost and 127.0.0.1 hosts with ports', async () => {
      for (const host of ['localhost:7800', '127.0.0.1:7800']) {
        const response = await request('/healthz', { headers: { host } });
        expect(response.status, host).toBe(200);
      }
    });

    it('allows [::1] host', async () => {
      const response = await request('/healthz', { headers: { host: '[::1]:7800' } });
      expect(response.status).toBe(200);
    });

    it('rejects hostnames that merely start with localhost', async () => {
      const response = await request('/healthz', {
        headers: { host: 'localhost.evil.example' },
      });
      expect(response.status).toBe(403);
    });

    it('accepts a configured extra host with any port', async () => {
      const response = await requestWithHosts('/healthz', ['memhub.example.com'], {
        headers: { host: 'memhub.example.com:8443' },
      });
      expect(response.status).toBe(200);
    });

    it('matches extra hosts case-insensitively', async () => {
      const response = await requestWithHosts('/healthz', ['memhub.example.com'], {
        headers: { host: 'MEMHUB.Example.com' },
      });
      expect(response.status).toBe(200);
    });

    it('keeps the local defaults when extra hosts are configured', async () => {
      const response = await requestWithHosts('/healthz', ['memhub.example.com'], {
        headers: { host: 'localhost:7800' },
      });
      expect(response.status).toBe(200);
    });

    it('still rejects unconfigured hosts when extras are set', async () => {
      const response = await requestWithHosts('/healthz', ['memhub.example.com'], {
        headers: { host: 'evil.example' },
      });
      expect(response.status).toBe(403);
    });

    it('accepts every host when "*" is configured', async () => {
      const response = await requestWithHosts('/healthz', ['*'], {
        headers: { host: 'anything.example:1234' },
      });
      expect(response.status).toBe(200);
    });

    it('accepts a configured IPv6 literal host', async () => {
      const response = await requestWithHosts('/healthz', ['[2001:db8::1]'], {
        headers: { host: '[2001:db8::1]:8443' },
      });
      expect(response.status).toBe(200);
    });
  });

  describe('GET /healthz', () => {
    it('returns the full health payload', async () => {
      t.cards.createCard({ title: 'a', body: 'a', type: 'fact', cues: [], confidence: 0.5 });
      t.db
        .prepare("INSERT INTO worker_state(key, value) VALUES ('indexer.model', 'mini-lm')")
        .run();
      const response = await request('/healthz');
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
      expect(body.cards).toEqual({ total: 1, active: 1, pending_index: 1 });
      expect(body.queue.pending_events).toBe(1);
      expect(body.queue.oldest_unindexed_age_s).toBeGreaterThanOrEqual(0);
      // model set but pending_index > 0 -> not ready
      expect(body.index).toEqual({ ready: false, model: 'mini-lm' });
    });

    it('reports index ready when a model is set and nothing is pending', async () => {
      t.db.prepare("INSERT INTO worker_state(key, value) VALUES ('indexer.model', 'm')").run();
      const body = (await (await request('/healthz')).json()) as {
        index: { ready: boolean; model: string | null };
      };
      expect(body.index).toEqual({ ready: true, model: 'm' });
    });
  });

  describe('POST /api/cards', () => {
    it('creates a card and returns 202 with id', async () => {
      const response = await request(
        '/api/cards',
        authed({
          method: 'POST',
          body: JSON.stringify({
            title: 'Node 24',
            body: 'Use node:sqlite',
            type: 'decision',
            cues: ['sqlite', 'node'],
            writer: 'claude-hook',
          }),
        })
      );
      expect(response.status).toBe(202);
      const body = (await response.json()) as {
        id: number;
        indexed: boolean;
        deduplicated: boolean;
      };
      expect(body).toEqual({ id: 1, indexed: false, deduplicated: false });
    });

    it('applies defaults for cues and confidence', async () => {
      const response = await request(
        '/api/cards',
        authed({
          method: 'POST',
          body: JSON.stringify({ title: 'T', body: 'B', type: 'fact' }),
        })
      );
      expect(response.status).toBe(202);
      const card = t.cards.getCard(1);
      expect(card?.cues).toEqual([]);
      expect(card?.confidence).toBe(0.5);
    });

    it('reuses a card for identical title+body', async () => {
      const payload = JSON.stringify({ title: 'T', body: 'B', type: 'fact' });
      await request('/api/cards', authed({ method: 'POST', body: payload }));
      const response = await request('/api/cards', authed({ method: 'POST', body: payload }));
      const body = (await response.json()) as { id: number; deduplicated: boolean };
      expect(body).toEqual({ id: 1, indexed: false, deduplicated: true });
    });

    it('rejects invalid payloads with 400', async () => {
      const cases = [
        JSON.stringify({ body: 'B', type: 'fact' }), // missing title
        JSON.stringify({ title: 'T', type: 'fact' }), // missing body
        JSON.stringify({ title: 'T', body: 'B', type: 'bogus' }), // bad type
        JSON.stringify({ title: 'T', body: 'B', type: 'fact', confidence: 5 }), // bad confidence
        JSON.stringify({ title: 'T', body: 'B', type: 'fact', cues: [''] }), // empty cue
        'not json',
      ];
      for (const payload of cases) {
        const response = await request('/api/cards', authed({ method: 'POST', body: payload }));
        expect(response.status, payload).toBe(400);
        const body = (await response.json()) as { error: { code: string; message: string } };
        expect(body.error.code).toBe('invalid_request');
        expect(typeof body.error.message).toBe('string');
      }
    });
  });

  describe('GET /api/cards', () => {
    beforeEach(async () => {
      for (const title of ['one', 'two', 'three']) {
        await request(
          '/api/cards',
          authed({
            method: 'POST',
            body: JSON.stringify({
              title,
              body: `body ${title}`,
              type: title === 'two' ? 'preference' : 'fact',
            }),
          })
        );
      }
    });

    it('lists cards id-descending', async () => {
      const response = await request('/api/cards', authed());
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        cards: { id: number }[];
        next_cursor: number | null;
      };
      expect(body.cards.map(c => c.id)).toEqual([3, 2, 1]);
      expect(body.next_cursor).toBeNull();
    });

    it('paginates with cursor and limit', async () => {
      const page1 = (await (await request('/api/cards?limit=2', authed())).json()) as {
        cards: { id: number }[];
        next_cursor: number;
      };
      expect(page1.cards.map(c => c.id)).toEqual([3, 2]);
      expect(page1.next_cursor).toBe(2);
      const page2 = (await (
        await request(`/api/cards?limit=2&cursor=${page1.next_cursor}`, authed())
      ).json()) as { cards: { id: number }[]; next_cursor: number | null };
      expect(page2.cards.map(c => c.id)).toEqual([1]);
      expect(page2.next_cursor).toBeNull();
    });

    it('filters by status and type', async () => {
      await request('/api/cards/3', authed({ method: 'DELETE' }));
      const archived = (await (await request('/api/cards?status=archived', authed())).json()) as {
        cards: { id: number }[];
      };
      expect(archived.cards.map(c => c.id)).toEqual([3]);

      const preferences = (await (
        await request('/api/cards?type=preference', authed())
      ).json()) as { cards: { id: number }[] };
      expect(preferences.cards.map(c => c.id)).toEqual([2]);
    });

    it('rejects invalid query parameters', async () => {
      for (const query of ['status=bogus', 'type=bogus', 'limit=0', 'limit=999', 'cursor=abc']) {
        const response = await request(`/api/cards?${query}`, authed());
        expect(response.status, query).toBe(400);
      }
    });
  });

  describe('GET /api/cards/:id', () => {
    it('returns a card', async () => {
      await request(
        '/api/cards',
        authed({ method: 'POST', body: JSON.stringify({ title: 'T', body: 'B', type: 'fact' }) })
      );
      const response = await request('/api/cards/1', authed());
      expect(response.status).toBe(200);
      const body = (await response.json()) as { card: { id: number; title: string } };
      expect(body.card.id).toBe(1);
      expect(body.card.title).toBe('T');
    });

    it('returns 404 for unknown ids and 400 for bad ids', async () => {
      expect((await request('/api/cards/99', authed())).status).toBe(404);
      expect((await request('/api/cards/abc', authed())).status).toBe(400);
      expect((await request('/api/cards/-1', authed())).status).toBe(400);
    });
  });

  describe('PATCH /api/cards/:id', () => {
    beforeEach(async () => {
      await request(
        '/api/cards',
        authed({
          method: 'POST',
          body: JSON.stringify({ title: 'T', body: 'B', type: 'fact', cues: ['x'] }),
        })
      );
      t.db.prepare('UPDATE cards SET indexed_at = ? WHERE id = 1').run('2024-01-01T00:00:00Z');
    });

    it('resets indexed_at and enqueues card.updated on content change', async () => {
      const response = await request(
        '/api/cards/1',
        authed({ method: 'PATCH', body: JSON.stringify({ body: 'new body' }) })
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { card: { indexed_at: string | null } };
      expect(body.card.indexed_at).toBeNull();
      const events = t.events.listAll();
      expect(events[events.length - 1].type).toBe('card.updated');
    });

    it('keeps indexed_at for non-content changes', async () => {
      const response = await request(
        '/api/cards/1',
        authed({ method: 'PATCH', body: JSON.stringify({ confidence: 0.9 }) })
      );
      const body = (await response.json()) as { card: { indexed_at: string | null } };
      expect(body.card.indexed_at).toBe('2024-01-01T00:00:00Z');
      expect(t.events.listAll().filter(e => e.type === 'card.updated')).toHaveLength(0);
    });

    it('requires at least one field', async () => {
      const response = await request('/api/cards/1', authed({ method: 'PATCH', body: '{}' }));
      expect(response.status).toBe(400);
    });

    it('returns 404 for unknown cards', async () => {
      const response = await request(
        '/api/cards/99',
        authed({ method: 'PATCH', body: JSON.stringify({ title: 'x' }) })
      );
      expect(response.status).toBe(404);
    });
  });

  describe('DELETE /api/cards/:id', () => {
    it('archives the card', async () => {
      await request(
        '/api/cards',
        authed({ method: 'POST', body: JSON.stringify({ title: 'T', body: 'B', type: 'fact' }) })
      );
      const response = await request('/api/cards/1', authed({ method: 'DELETE' }));
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        card: { status: string; archived_at: string | null };
      };
      expect(body.card.status).toBe('archived');
      expect(body.card.archived_at).not.toBeNull();
    });

    it('returns 404 for unknown cards', async () => {
      expect((await request('/api/cards/9', authed({ method: 'DELETE' }))).status).toBe(404);
    });
  });

  describe('POST /api/cards/:id/invalidate', () => {
    beforeEach(async () => {
      await request(
        '/api/cards',
        authed({ method: 'POST', body: JSON.stringify({ title: 'old', body: 'B', type: 'fact' }) })
      );
      await request(
        '/api/cards',
        authed({ method: 'POST', body: JSON.stringify({ title: 'new', body: 'B', type: 'fact' }) })
      );
    });

    it('marks the card superseded without a target', async () => {
      const response = await request(
        '/api/cards/1/invalidate',
        authed({ method: 'POST', body: '{}' })
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        card: { status: string; superseded_by: number | null };
      };
      expect(body.card.status).toBe('superseded');
      expect(body.card.superseded_by).toBeNull();
    });

    it('accepts an empty body', async () => {
      const response = await request('/api/cards/1/invalidate', authed({ method: 'POST' }));
      expect(response.status).toBe(200);
    });

    it('records the successor card id', async () => {
      const response = await request(
        '/api/cards/1/invalidate',
        authed({ method: 'POST', body: JSON.stringify({ card_id: 2 }) })
      );
      const body = (await response.json()) as { card: { superseded_by: number } };
      expect(body.card.superseded_by).toBe(2);
    });

    it('rejects unknown successors and self-references', async () => {
      const bad = await request(
        '/api/cards/1/invalidate',
        authed({ method: 'POST', body: JSON.stringify({ card_id: 99 }) })
      );
      expect(bad.status).toBe(400);
      const self = await request(
        '/api/cards/1/invalidate',
        authed({ method: 'POST', body: JSON.stringify({ card_id: 1 }) })
      );
      expect(self.status).toBe(400);
    });
  });

  describe('POST /api/search', () => {
    beforeEach(async () => {
      await request(
        '/api/cards',
        authed({
          method: 'POST',
          body: JSON.stringify({
            title: 'docker deploy',
            body: 'containers everywhere',
            type: 'pattern',
            cues: ['ops'],
          }),
        })
      );
    });

    it('searches by keyword and reports mode_used', async () => {
      const response = await request(
        '/api/search',
        authed({ method: 'POST', body: JSON.stringify({ query: 'docker' }) })
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        results: { id: number; title: string; score: number; matched_by: string }[];
        mode_used: string;
      };
      expect(body.mode_used).toBe('keyword');
      expect(body.results).toHaveLength(1);
      expect(body.results[0].id).toBe(1);
      expect(body.results[0].matched_by).toBe('fts');
      expect(typeof body.results[0].score).toBe('number');
    });

    it('auto mode degrades to keyword while the index is not ready', async () => {
      const response = await request(
        '/api/search',
        authed({ method: 'POST', body: JSON.stringify({ query: 'ops', mode: 'auto' }) })
      );
      const body = (await response.json()) as { mode_used: string; results: unknown[] };
      expect(body.mode_used).toBe('keyword');
      expect(body.results).toHaveLength(1); // cue match
    });

    it('semantic mode returns 503 while the index is not ready', async () => {
      const response = await request(
        '/api/search',
        authed({ method: 'POST', body: JSON.stringify({ query: 'x', mode: 'semantic' }) })
      );
      expect(response.status).toBe(503);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('index_not_ready');
    });

    it('rejects invalid search payloads', async () => {
      const cases = [
        JSON.stringify({}),
        JSON.stringify({ query: '' }),
        JSON.stringify({ query: 'x', mode: 'bogus' }),
        JSON.stringify({ query: 'x', limit: 0 }),
      ];
      for (const payload of cases) {
        const response = await request('/api/search', authed({ method: 'POST', body: payload }));
        expect(response.status, payload).toBe(400);
      }
    });
  });

  describe('POST /api/search with a semantic index', () => {
    let semantic: SemanticSearch;
    let vectors: FakeVectorStore;

    function semanticRequest(path: string, init: RequestInit = {}): Promise<Response> {
      const headers = {
        host: '127.0.0.1:7800',
        ...((init.headers as Record<string, string>) ?? {}),
      };
      return appWithSemantic(semantic).request(path, { ...init, headers });
    }

    beforeEach(() => {
      vectors = new FakeVectorStore();
      semantic = new SemanticSearch({
        embedder: new FakeEmbedder(),
        vectors,
        cards: t.cards,
      });
    });

    it('answers semantic mode once the index is ready', async () => {
      await request(
        '/api/cards',
        authed({
          method: 'POST',
          body: JSON.stringify({ title: 'needle card', body: 'semantics', type: 'fact' }),
        })
      );
      // The card was indexed with the exact query vector.
      await vectors.upsert(1, deterministicVector('needle'));
      t.db.prepare('UPDATE cards SET indexed_at = ? WHERE id = 1').run('2024-01-01T00:00:00Z');
      semantic.setReady(true);

      const response = await semanticRequest(
        '/api/search',
        authed({ method: 'POST', body: JSON.stringify({ query: 'needle', mode: 'semantic' }) })
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        results: { id: number; matched_by: string }[];
        mode_used: string;
      };
      expect(body.mode_used).toBe('semantic');
      expect(body.results.map(r => r.id)).toEqual([1]);
      expect(body.results[0].matched_by).toBe('semantic');
    });

    it('includes unindexed cards through the keyword fallback', async () => {
      await request(
        '/api/cards',
        authed({
          method: 'POST',
          body: JSON.stringify({ title: 'fresh needle', body: 'not indexed yet', type: 'fact' }),
        })
      );
      semantic.setReady(true);

      const response = await semanticRequest(
        '/api/search',
        authed({ method: 'POST', body: JSON.stringify({ query: 'needle', mode: 'semantic' }) })
      );
      const body = (await response.json()) as {
        results: { id: number; matched_by: string }[];
        mode_used: string;
      };
      expect(body.mode_used).toBe('semantic');
      expect(body.results.map(r => r.id)).toEqual([1]);
      expect(body.results[0].matched_by).toBe('fallback');
    });

    it('auto mode prefers semantic once ready', async () => {
      semantic.setReady(true);
      const response = await semanticRequest(
        '/api/search',
        authed({ method: 'POST', body: JSON.stringify({ query: 'anything', mode: 'auto' }) })
      );
      const body = (await response.json()) as { mode_used: string };
      expect(body.mode_used).toBe('semantic');
    });

    it('returns 503 for semantic mode while the injected index is not ready', async () => {
      const response = await semanticRequest(
        '/api/search',
        authed({ method: 'POST', body: JSON.stringify({ query: 'x', mode: 'semantic' }) })
      );
      expect(response.status).toBe(503);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('index_not_ready');
    });

    it('healthz reports readiness from the injected semantic index', async () => {
      const notReady = (await (
        await appWithSemantic(semantic).request('/healthz', { headers: { host: 'localhost' } })
      ).json()) as { index: { ready: boolean } };
      expect(notReady.index.ready).toBe(false);

      semantic.setReady(true);
      const ready = (await (
        await appWithSemantic(semantic).request('/healthz', { headers: { host: 'localhost' } })
      ).json()) as { index: { ready: boolean } };
      expect(ready.index.ready).toBe(true);
    });
  });

  describe('GET /api/activity', () => {
    it('lists activity entries with pagination', async () => {
      for (const title of ['a', 'b', 'c']) {
        await request(
          '/api/cards',
          authed({ method: 'POST', body: JSON.stringify({ title, body: 'B', type: 'fact' }) })
        );
      }
      const response = await request('/api/activity?limit=2', authed());
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

    it('rejects a bad cursor', async () => {
      expect((await request('/api/activity?cursor=nope', authed())).status).toBe(400);
    });
  });

  describe('GET /api/queue', () => {
    it('returns queue statistics', async () => {
      await request(
        '/api/cards',
        authed({ method: 'POST', body: JSON.stringify({ title: 'T', body: 'B', type: 'fact' }) })
      );
      const response = await request('/api/queue', authed());
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

  describe('POST /api/shutdown', () => {
    it('requests a graceful shutdown', async () => {
      const response = await request('/api/shutdown', authed({ method: 'POST', body: '{}' }));
      expect(response.status).toBe(200);
      const body = (await response.json()) as { ok: boolean };
      expect(body.ok).toBe(true);
      expect(requestShutdown).toHaveBeenCalledTimes(1);
    });

    it('requires the token', async () => {
      const response = await request('/api/shutdown', { method: 'POST' });
      expect(response.status).toBe(401);
    });
  });

  describe('unknown routes', () => {
    it('returns a 404 error body', async () => {
      const response = await request('/api/nope', authed());
      expect(response.status).toBe(404);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('not_found');
    });
  });
});

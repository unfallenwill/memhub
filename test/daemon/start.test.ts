import { readFileSync } from 'fs';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  EMBEDDING_MODEL_ID,
  TransformersEmbedder,
} from '../../src/embedding/transformers-embedder.js';
import {
  createDefaultWorkerContext,
  PortInUseError,
  SHUTDOWN_FLUSH_DELAY_MS,
  startDaemon,
  WORKER_START_RETRY_MS,
  type DaemonHandle,
} from '../../src/daemon/start.js';
import { LanceVectorIndex } from '../../src/storage/vector-index.js';
import { getTokenPath } from '../../src/paths.js';
import { createTestDb, FakeEmbedder, FakeVectorStore } from '../test-utils.js';

describe('startDaemon', () => {
  // Regression guard: @hono/node-server replaces global Request/Response by
  // default, which breaks Transformers.js' model file caching (the downloaded
  // ONNX model is never stored and the worker cannot start). The daemon must
  // serve without touching the globals.
  const NativeRequest = globalThis.Request;
  const NativeResponse = globalThis.Response;

  let t: ReturnType<typeof createTestDb>;
  let handle: DaemonHandle;
  let token: string;

  beforeAll(async () => {
    t = createTestDb();
    t.close(); // release the file so the daemon can open it exclusively (WAL)
    handle = await startDaemon({
      home: t.home,
      port: 0,
      worker: {
        // Real LanceDB store in the temp home; fake embedder (no model download).
        embedder: new FakeEmbedder(),
        vectors: new LanceVectorIndex(join(t.home, 'lancedb')),
      },
    });
    token = readFileSync(getTokenPath(t.home), 'utf-8').trim();
  });

  afterAll(async () => {
    await handle.close();
  });

  function url(path: string): string {
    return `http://127.0.0.1:${handle.port}${path}`;
  }

  it('binds a free port and reports it', () => {
    expect(handle.port).toBeGreaterThan(0);
    expect(handle.pid).toBe(process.pid);
  });

  it('does not override the global Request/Response classes', () => {
    expect(globalThis.Request).toBe(NativeRequest);
    expect(globalThis.Response).toBe(NativeResponse);
  });

  it('serves /healthz without a token', async () => {
    const response = await fetch(url('/healthz'));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { app: string; pid: number; version: string };
    expect(body.app).toBe('memhub');
    expect(body.pid).toBe(process.pid);
    expect(typeof body.version).toBe('string');
  });

  it('requires the token for API routes over real HTTP', async () => {
    const denied = await fetch(url('/api/cards'));
    expect(denied.status).toBe(401);

    const ok = await fetch(url('/api/cards'), { headers: { 'x-memhub-token': token } });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { cards: unknown[] };
    expect(body.cards).toEqual([]);
  });

  it('accepts writes and searches over real HTTP', async () => {
    const created = await fetch(url('/api/cards'), {
      method: 'POST',
      headers: { 'x-memhub-token': token },
      body: JSON.stringify({ title: 'daemon card', body: 'real http write', type: 'fact' }),
    });
    expect(created.status).toBe(202);
    const createdBody = (await created.json()) as { id: number };
    expect(createdBody.id).toBe(1);

    const search = await fetch(url('/api/search'), {
      method: 'POST',
      headers: { 'x-memhub-token': token },
      body: JSON.stringify({ query: 'daemon' }),
    });
    const searchBody = (await search.json()) as { results: { id: number }[]; mode_used: string };
    // Depending on whether the worker already indexed the card, auto mode
    // resolves to keyword or semantic; either way the card must be found.
    expect(['keyword', 'semantic']).toContain(searchBody.mode_used);
    expect(searchBody.results.map(r => r.id)).toEqual([1]);
  });

  it(
    'indexes written cards in the background and serves semantic search',
    { timeout: 15_000 },
    async () => {
      // Wait until the worker has actually indexed the card.
      const deadline = Date.now() + 10_000;
      for (;;) {
        const response = await fetch(url('/api/cards/1'), {
          headers: { 'x-memhub-token': token },
        });
        const body = (await response.json()) as { card: { indexed_at: string | null } };
        if (body.card.indexed_at !== null) break;
        if (Date.now() >= deadline) {
          throw new Error('the worker did not index the card in time');
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }

      const health = (await (await fetch(url('/healthz'))).json()) as {
        index: { ready: boolean; model: string | null };
      };
      expect(health.index.ready).toBe(true);
      expect(health.index.model).toBe('fake-embedding-model');

      const response = await fetch(url('/api/search'), {
        method: 'POST',
        headers: { 'x-memhub-token': token },
        body: JSON.stringify({ query: 'daemon card', mode: 'semantic' }),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        results: { id: number; matched_by: string }[];
        mode_used: string;
      };
      expect(body.mode_used).toBe('semantic');
      expect(body.results.map(r => r.id)).toContain(1);
      expect(body.results[0].matched_by).toBe('semantic');
    }
  );

  it('serves the device flow start endpoint on the real daemon', async () => {
    const response = await fetch(url('/oauth/device/code'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: 'memhub-cli' }),
    });
    expect(response.status).toBe(200);
    const grant = (await response.json()) as { requires_setup: boolean; user_code: string };
    // Fresh test home: no admin password has been set.
    expect(grant.requires_setup).toBe(true);
    expect(grant.user_code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  });

  it('shuts down gracefully via POST /api/shutdown', { timeout: 15_000 }, async () => {
    const response = await fetch(url('/api/shutdown'), {
      method: 'POST',
      headers: { 'x-memhub-token': token },
    });
    expect(response.status).toBe(200);
    // Give the daemon's internal flush delay time to fire, then close
    // explicitly if it has not already (close is idempotent).
    await new Promise(resolve => setTimeout(resolve, SHUTDOWN_FLUSH_DELAY_MS + 100));
    await handle.close();
    await expect(fetch(url('/healthz'))).rejects.toThrow();
  });

  it('rejects with PortInUseError when the port is taken', async () => {
    const blocker = await startDaemon({
      home: t.home,
      port: 0,
      worker: { embedder: new FakeEmbedder(), vectors: new FakeVectorStore() },
    });
    let caught: unknown;
    try {
      await startDaemon({ home: t.home, port: blocker.port });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PortInUseError);
    await blocker.close();
  });
});

describe('worker failure handling', () => {
  it(
    'keeps serving keyword search and retries when the worker cannot start',
    { timeout: 20_000 },
    async () => {
      const t = createTestDb();
      t.close();
      const failing = new FakeEmbedder({ failLoad: true });
      const handle = await startDaemon({
        home: t.home,
        port: 0,
        worker: { embedder: failing, vectors: new FakeVectorStore(), retryDelayMs: 100 },
      });
      try {
        const token = readFileSync(getTokenPath(t.home), 'utf-8').trim();

        // Keyword search works while the semantic index is unavailable.
        await fetch(`http://127.0.0.1:${handle.port}/api/cards`, {
          method: 'POST',
          headers: { 'x-memhub-token': token },
          body: JSON.stringify({ title: 'offline card', body: 'keyword only', type: 'fact' }),
        });
        const auto = await fetch(`http://127.0.0.1:${handle.port}/api/search`, {
          method: 'POST',
          headers: { 'x-memhub-token': token },
          body: JSON.stringify({ query: 'offline' }),
        });
        const autoBody = (await auto.json()) as { mode_used: string; results: unknown[] };
        expect(autoBody.mode_used).toBe('keyword');
        expect(autoBody.results).toHaveLength(1);

        const semantic = await fetch(`http://127.0.0.1:${handle.port}/api/search`, {
          method: 'POST',
          headers: { 'x-memhub-token': token },
          body: JSON.stringify({ query: 'offline', mode: 'semantic' }),
        });
        expect(semantic.status).toBe(503);

        // The startup is retried in the background.
        await new Promise(resolve => setTimeout(resolve, 350));
        expect(failing.ensureLoadedCalls).toBeGreaterThan(1);
      } finally {
        await handle.close();
      }
    }
  );
});

describe('createDefaultWorkerContext', () => {
  it('builds the production embedder and vector store without I/O', () => {
    const context = createDefaultWorkerContext('/memhub-home');
    expect(context.embedder).toBeInstanceOf(TransformersEmbedder);
    expect(context.embedder.modelId).toBe(EMBEDDING_MODEL_ID);
    expect(context.vectors).toBeInstanceOf(LanceVectorIndex);
    expect(WORKER_START_RETRY_MS).toBe(60_000);
  });
});

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'fs';
import { createServer } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
import { hashPassword } from '../../src/auth/admin-password.js';
import { AdminPasswordStore } from '../../src/db/admin-password.js';
import { openDatabase } from '../../src/db/database.js';
import { PORT_ENV } from '../../src/config/env.js';
import { LanceVectorIndex } from '../../src/storage/vector-index.js';
import { getSetupCodePath, getTokenPath } from '../../src/paths.js';
import { createTestDb, FakeEmbedder, FakeVectorStore, moduleNotFoundError } from '../test-utils.js';

/** A free TCP port on the loopback interface. */
async function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

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

  it('binds the port from MEMHUB_PORT when no port is given', async () => {
    // Regression: the daemon used to hard-code the default port and
    // ignored MEMHUB_PORT, so a library user got a different port than
    // the CLI.
    const t2 = createTestDb();
    t2.close();
    const port = await freePort();
    const original = process.env[PORT_ENV];
    process.env[PORT_ENV] = String(port);
    let handle: DaemonHandle | undefined;
    try {
      handle = await startDaemon({
        home: t2.home,
        worker: { embedder: new FakeEmbedder(), vectors: new FakeVectorStore() },
      });
      expect(handle.port).toBe(port);
    } finally {
      if (original === undefined) delete process.env[PORT_ENV];
      else process.env[PORT_ENV] = original;
      await handle?.close();
    }
  });

  it('rejects an invalid MEMHUB_PORT instead of silently binding the default', async () => {
    // A typo in the environment must not bind 7800 behind the user's
    // back: the daemon reports the value it could not read.
    const t2 = createTestDb();
    t2.close();
    const original = process.env[PORT_ENV];
    process.env[PORT_ENV] = 'not-a-port';
    try {
      await expect(
        startDaemon({
          home: t2.home,
          worker: { embedder: new FakeEmbedder(), vectors: new FakeVectorStore() },
        })
      ).rejects.toThrow('invalid MEMHUB_PORT value: not-a-port');
    } finally {
      if (original === undefined) delete process.env[PORT_ENV];
      else process.env[PORT_ENV] = original;
    }
  });
});

describe('teardown resilience', () => {
  it('closes the HTTP server even when the worker fails to stop', { timeout: 15_000 }, async () => {
    const t = createTestDb();
    t.close();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handle = await startDaemon({
      home: t.home,
      port: 0,
      worker: { embedder: new FakeEmbedder(), vectors: new FakeVectorStore() },
      // A worker whose shutdown fails: the teardown must not skip the
      // steps after it (the HTTP socket would leak otherwise).
      indexer: {
        async start(): Promise<void> {},
        async stop(): Promise<void> {
          throw new Error('worker stop failed');
        },
      },
    });
    try {
      const url = `http://127.0.0.1:${handle.port}/healthz`;
      expect((await fetch(url)).status).toBe(200);

      await handle.close();

      // The teardown completed despite the failing worker.
      await expect(handle.closed).resolves.toBeUndefined();
      // The HTTP server was closed: the socket is gone.
      await expect(fetch(url)).rejects.toThrow();
      // The failure was reported.
      const logged = log.mock.calls.map(call => call.join(' ')).join('\n');
      expect(logged).toContain('indexing worker');
    } finally {
      log.mockRestore();
      await handle.close();
    }
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

describe('missing semantic stack handling', () => {
  it(
    'degrades to keyword-only mode without retrying when the packages are missing',
    { timeout: 15_000 },
    async () => {
      const t = createTestDb();
      t.close();
      const missing = new FakeEmbedder({
        failLoad: true,
        failLoadWith: moduleNotFoundError('@huggingface/transformers'),
      });
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      const handle = await startDaemon({
        home: t.home,
        port: 0,
        worker: { embedder: missing, vectors: new FakeVectorStore(), retryDelayMs: 100 },
      });
      try {
        const token = readFileSync(getTokenPath(t.home), 'utf-8').trim();

        // Keyword search keeps working.
        await fetch(`http://127.0.0.1:${handle.port}/api/cards`, {
          method: 'POST',
          headers: { 'x-memhub-token': token },
          body: JSON.stringify({ title: 'plain card', body: 'keyword only', type: 'fact' }),
        });
        const auto = await fetch(`http://127.0.0.1:${handle.port}/api/search`, {
          method: 'POST',
          headers: { 'x-memhub-token': token },
          body: JSON.stringify({ query: 'plain' }),
        });
        const autoBody = (await auto.json()) as { mode_used: string; results: unknown[] };
        expect(autoBody.mode_used).toBe('keyword');
        expect(autoBody.results).toHaveLength(1);

        // Explicit semantic mode explains how to install the stack.
        const semantic = await fetch(`http://127.0.0.1:${handle.port}/api/search`, {
          method: 'POST',
          headers: { 'x-memhub-token': token },
          body: JSON.stringify({ query: 'plain', mode: 'semantic' }),
        });
        expect(semantic.status).toBe(501);
        const semanticBody = (await semantic.json()) as { error: { code: string } };
        expect(semanticBody.error.code).toBe('semantic_not_installed');

        // A missing package is permanent: no retries after the first failure.
        await new Promise(resolve => setTimeout(resolve, 350));
        expect(missing.ensureLoadedCalls).toBe(1);

        // The daemon logged the keyword-only degradation with the hint.
        const logged = log.mock.calls.map(call => call.join(' ')).join('\n');
        expect(logged).toContain('keyword-only');
        expect(logged).toContain('npm install');
      } finally {
        log.mockRestore();
        await handle.close();
      }
    }
  );
});

describe('first-run setup code', () => {
  it('writes a setup-code file for a fresh home', async () => {
    const t = createTestDb();
    t.close();
    const handle = await startDaemon({
      home: t.home,
      port: 0,
      worker: { embedder: new FakeEmbedder(), vectors: new FakeVectorStore() },
    });
    try {
      const path = getSetupCodePath(t.home);
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, 'utf-8').trim()).toMatch(/^[0-9A-Z]{6}-[0-9A-Z]{6}$/);
      if (process.platform !== 'win32') {
        expect(statSync(path).mode & 0o777).toBe(0o600);
        // The home directory is tightened to owner-only (token, setup
        // code, database and logs all live here).
        expect(statSync(t.home).mode & 0o777).toBe(0o700);
      }
    } finally {
      await handle.close();
    }
  });

  it('does not write one when the admin password already exists', async () => {
    // createTestDb().close() removes its directory, so build a home that
    // survives (the daemon must reopen the initialized database).
    const home = mkdtempSync(join(tmpdir(), 'memhub-setupcode-'));
    if (process.platform !== 'win32') {
      chmodSync(home, 0o755); // pre-loosened: the daemon must re-tighten
    }
    const db = openDatabase(join(home, 'memhub.db'));
    new AdminPasswordStore(db).set(hashPassword('password-1'));
    db.close();
    const handle = await startDaemon({
      home,
      port: 0,
      worker: { embedder: new FakeEmbedder(), vectors: new FakeVectorStore() },
    });
    try {
      expect(existsSync(getSetupCodePath(home))).toBe(false);
      if (process.platform !== 'win32') {
        expect(statSync(home).mode & 0o777).toBe(0o700);
      }
    } finally {
      await handle.close();
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
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

/**
 * The edge cases of the daemon bootstrap (src/daemon/start.ts).
 *
 * The bootstrap prints the first-run setup code once, shuts down only
 * once, survives a data directory it cannot tighten and a setup code it
 * cannot write, and knows which bind addresses are loopback.
 */

import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isLoopbackHost } from '../../src/daemon/start.js';
import { getSetupCodePath, getTokenPath } from '../../src/paths.js';
import { createTestDb, FakeEmbedder, FakeVectorStore } from '../test-utils.js';

describe('the loopback addresses', () => {
  it('recognizes every spelling of the loopback interface', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('example.com')).toBe(false);
  });
});

describe('a daemon on a fresh home', () => {
  const homes: string[] = [];

  function tempHome(): string {
    const home = mkdtempSync(join(tmpdir(), 'memhub-daemon-edges-'));
    homes.push(home);
    return home;
  }

  beforeEach(() => {
    // The daemon prints the setup code and logs worker problems; keep
    // the test output readable.
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('fs');
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    for (const home of homes.splice(0)) {
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it('prints the setup code only once', async () => {
    const { startDaemon } = await import('../../src/daemon/start.js');
    const t = createTestDb();
    t.close();
    const log = vi.mocked(console.log);
    const handle = await startDaemon({
      home: t.home,
      port: 0,
      worker: { embedder: new FakeEmbedder(), vectors: new FakeVectorStore() },
    });
    try {
      const base = `http://127.0.0.1:${handle.port}`;
      const grant = await fetch(`${base}/oauth/device/code`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: 'memhub-cli' }),
      });
      const body = (await grant.json()) as { user_code: string };

      // The authorize route asks for the setup code again; the daemon
      // must not print it a second time.
      const authorize = await fetch(`${base}/oauth/device/authorize`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `user_code=${body.user_code}&password=wrongpassword`,
        redirect: 'manual',
      });
      expect(authorize.status).toBe(302);

      const printed = log.mock.calls
        .map(call => call.join(' '))
        .filter(line => line.includes('first-run setup code'));
      expect(printed).toHaveLength(1);
    } finally {
      await handle.close();
    }
  });

  it('ignores a second shutdown request', async () => {
    const { startDaemon } = await import('../../src/daemon/start.js');
    const t = createTestDb();
    t.close();
    const handle = await startDaemon({
      home: t.home,
      port: 0,
      worker: { embedder: new FakeEmbedder(), vectors: new FakeVectorStore() },
    });
    const token = readFileSync(getTokenPath(t.home), 'utf-8').trim();
    const base = `http://127.0.0.1:${handle.port}`;
    try {
      const first = await fetch(`${base}/api/shutdown`, {
        method: 'POST',
        headers: { 'x-memhub-token': token },
      });
      expect(first.status).toBe(200);
      const second = await fetch(`${base}/api/shutdown`, {
        method: 'POST',
        headers: { 'x-memhub-token': token },
      });
      expect(second.status).toBe(200);
    } finally {
      await handle.close();
    }
  });

  it('runs without a semantic backend in keyword-only mode', async () => {
    const { startDaemon } = await import('../../src/daemon/start.js');
    const t = createTestDb();
    t.close();
    // No embedder and no vector store: the daemon stays keyword-only.
    const handle = await startDaemon({ home: t.home, port: 0, worker: {} });
    const token = readFileSync(getTokenPath(t.home), 'utf-8').trim();
    try {
      const response = await fetch(`http://127.0.0.1:${handle.port}/api/search`, {
        method: 'POST',
        headers: { 'x-memhub-token': token },
        body: JSON.stringify({ query: 'anything', mode: 'semantic' }),
      });
      // Without a semantic backend the index is simply not ready.
      expect(response.status).toBe(503);
    } finally {
      await handle.close();
    }
  });

  it('starts when the data directory cannot be tightened and the setup code cannot be written', async () => {
    const home = tempHome();
    vi.doMock('fs', async importOriginal => {
      const actual = await importOriginal<typeof import('fs')>();
      return {
        ...actual,
        chmodSync: (path: Parameters<typeof actual.chmodSync>[0], mode: number): void => {
          if (String(path) === home) throw new Error('the directory cannot be tightened');
          actual.chmodSync(path, mode);
        },
        writeFileSync: (
          path: Parameters<typeof actual.writeFileSync>[0],
          data: Parameters<typeof actual.writeFileSync>[1],
          options?: Parameters<typeof actual.writeFileSync>[2]
        ): void => {
          if (String(path) === getSetupCodePath(home)) {
            throw new Error('the setup code cannot be written');
          }
          actual.writeFileSync(path, data, options);
        },
      };
    });
    vi.resetModules();
    const { startDaemon } = await import('../../src/daemon/start.js');
    const logged = vi.mocked(console.error);

    const handle = await startDaemon({
      home,
      port: 0,
      worker: { embedder: new FakeEmbedder(), vectors: new FakeVectorStore() },
    });
    try {
      // The daemon runs; it just has no setup code to hand out.
      const response = await fetch(`http://127.0.0.1:${handle.port}/healthz`);
      expect(response.status).toBe(200);
      const messages = logged.mock.calls.map(call => call.join(' ')).join('\n');
      expect(messages).toContain('failed to mint the setup code');
    } finally {
      await handle.close();
    }
  });
});

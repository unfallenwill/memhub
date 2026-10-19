/**
 * The teardown of the daemon survives every failing step.
 *
 * The shutdown sequence isolates each step: the job timers, the
 * indexing worker, the HTTP server and the database are closed one
 * after the other, and a step that fails must never skip the steps
 * after it (a throwing worker.stop() used to leave the socket open).
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getSetupCodePath } from '../../src/paths.js';
import { FakeEmbedder, FakeVectorStore } from '../test-utils.js';

/** A home directory that is removed when the test ends. */
function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'memhub-teardown-'));
}

/** The messages the daemon logged. */
function loggedMessages(spy: { mock: { calls: unknown[][] } }): string {
  return spy.mock.calls.map(call => call.join(' ')).join('\n');
}

/**
 * Ask the daemon whether it answers.
 *
 * A keep-alive connection is used on purpose: a request that asks the
 * server to close the connection afterwards (HTTP/1.0 style) is reset
 * by Node itself every now and then, which would make the test flaky.
 */
async function isHealthy(port: number): Promise<boolean> {
  const response = await fetch(`http://127.0.0.1:${port}/healthz`);
  return response.status === 200;
}

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('@hono/node-server');
  vi.doUnmock('../../src/db/database.js');
  vi.doUnmock('fs');
  vi.restoreAllMocks();
});

describe('a daemon whose job timers refuse to stop', () => {
  it('still closes the HTTP server and reports the failure', async () => {
    const home = tempHome();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { JobTimers } = await import('../../src/worker/timers.js');
    const { startDaemon } = await import('../../src/daemon/start.js');

    const originalStop = JobTimers.prototype.stop;
    vi.spyOn(JobTimers.prototype, 'stop').mockImplementation(function (this: JobTimers): void {
      // Clear the real timers first, then fail: the daemon must not
      // keep a timer running after the shutdown.
      originalStop.call(this);
      throw new Error('the timers refuse to stop');
    });

    const handle = await startDaemon({
      home,
      port: 0,
      worker: { embedder: new FakeEmbedder(), vectors: new FakeVectorStore() },
    });
    try {
      expect(await isHealthy(handle.port)).toBe(true);

      await handle.close();

      // The teardown ran to the end despite the failing timers: the
      // daemon settled and reported the failure.
      await expect(handle.closed).resolves.toBeUndefined();
      expect(loggedMessages(log)).toContain('error stopping the job timers');
    } finally {
      await handle.close();
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

describe('a daemon whose database refuses to close', () => {
  it('still settles the shutdown and reports the failure', async () => {
    const home = tempHome();
    vi.doMock('../../src/db/database.js', async importOriginal => {
      const actual = await importOriginal<typeof import('../../src/db/database.js')>();
      return {
        ...actual,
        openDatabase: (path: string) => {
          const db = actual.openDatabase(path);
          const close = db.close.bind(db);
          db.close = (): void => {
            // The file is released, but the caller is told it failed.
            close();
            throw new Error('the database refuses to close');
          };
          return db;
        },
      };
    });
    vi.resetModules();
    const { startDaemon } = await import('../../src/daemon/start.js');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});

    const handle = await startDaemon({
      home,
      port: 0,
      worker: { embedder: new FakeEmbedder(), vectors: new FakeVectorStore() },
    });
    try {
      await handle.close();

      // The shutdown settled even though the database could not be closed.
      await expect(handle.closed).resolves.toBeUndefined();
      expect(loggedMessages(log)).toContain('error closing the database');
    } finally {
      await handle.close();
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

describe('a daemon whose HTTP server refuses to close', () => {
  it('still closes the database and reports the failure', async () => {
    const home = tempHome();
    vi.doMock('@hono/node-server', () => ({
      serve: (options: { port: number }, callback: (info: { port: number }) => void) => {
        callback({ port: options.port });
        return {
          once: (): void => undefined,
          close: (): void => {
            throw new Error('the server refuses to close');
          },
          closeAllConnections: (): void => undefined,
        };
      },
    }));
    vi.resetModules();
    const { startDaemon } = await import('../../src/daemon/start.js');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});

    const handle = await startDaemon({
      home,
      port: 0,
      worker: { embedder: new FakeEmbedder(), vectors: new FakeVectorStore() },
    });
    try {
      await handle.close();

      await expect(handle.closed).resolves.toBeUndefined();
      expect(loggedMessages(log)).toContain('error closing the HTTP server');
    } finally {
      await handle.close();
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

describe('the first-run setup of a daemon', () => {
  it('deletes the setup code once the admin password is set', async () => {
    const home = tempHome();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { startDaemon } = await import('../../src/daemon/start.js');

    const handle = await startDaemon({
      home,
      port: 0,
      worker: { embedder: new FakeEmbedder(), vectors: new FakeVectorStore() },
    });
    try {
      const setupCodePath = getSetupCodePath(home);
      expect(existsSync(setupCodePath)).toBe(true);
      const setupCode = readFileSync(setupCodePath, 'utf-8').trim();
      const base = `http://127.0.0.1:${handle.port}`;

      const grant = await fetch(`${base}/oauth/device/code`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: 'memhub-cli' }),
      });
      const { user_code: userCode } = (await grant.json()) as { user_code: string };

      const form = new URLSearchParams({
        user_code: userCode,
        password: 'a-long-enough-password',
        password_confirm: 'a-long-enough-password',
        setup_code: setupCode,
      });
      const authorized = await fetch(`${base}/oauth/device/authorize`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        redirect: 'manual',
      });
      expect(authorized.status).toBe(302);

      // The one-time setup code is gone: the admin password is set.
      expect(existsSync(setupCodePath)).toBe(false);
    } finally {
      await handle.close();
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it('reports a setup code file it cannot remove', async () => {
    const home = tempHome();
    vi.doMock('fs', async importOriginal => {
      const actual = await importOriginal<typeof import('fs')>();
      return {
        ...actual,
        rmSync: (
          path: Parameters<typeof actual.rmSync>[0],
          options?: Parameters<typeof actual.rmSync>[1]
        ): void => {
          if (String(path) === getSetupCodePath(home)) {
            throw new Error('the setup code file cannot be removed');
          }
          actual.rmSync(path, options);
        },
      };
    });
    vi.resetModules();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { startDaemon } = await import('../../src/daemon/start.js');

    const handle = await startDaemon({
      home,
      port: 0,
      worker: { embedder: new FakeEmbedder(), vectors: new FakeVectorStore() },
    });
    try {
      const setupCodePath = getSetupCodePath(home);
      const setupCode = readFileSync(setupCodePath, 'utf-8').trim();
      const base = `http://127.0.0.1:${handle.port}`;

      const grant = await fetch(`${base}/oauth/device/code`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: 'memhub-cli' }),
      });
      const { user_code: userCode } = (await grant.json()) as { user_code: string };

      const form = new URLSearchParams({
        user_code: userCode,
        password: 'a-long-enough-password',
        password_confirm: 'a-long-enough-password',
        setup_code: setupCode,
      });
      const authorized = await fetch(`${base}/oauth/device/authorize`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        redirect: 'manual',
      });

      // The setup itself succeeded: the daemon only failed to delete
      // the one-time code, which it reports but does not treat as fatal.
      expect(authorized.status).toBe(302);
      expect(authorized.headers.get('location')).toContain('#token=');
      // The code file is still there: the removal failed.
      expect(existsSync(setupCodePath)).toBe(true);
      // The failure was reported.
      expect(loggedMessages(log)).toContain('failed to remove the setup code file');
    } finally {
      await handle.close();
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

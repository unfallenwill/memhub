/**
 * The kill and the token lookup of `memhub stop`
 * (src/cli/commands/stop.ts).
 *
 * When taskkill fails without a message of its own the exit code is
 * reported instead, and the token file is looked up in the data
 * directory of the environment when the caller does not name one.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { killProcessTree, runStopCommand } from '../../../src/cli/commands/stop.js';
import { MEMHUB_HOME_ENV } from '../../../src/paths.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawnSync: vi.fn() };
});

const healthBody = {
  app: 'memhub',
  pid: 555,
  uptime: 10,
  version: '1.0.0',
  cards: { total: 0, active: 0, pending_index: 0 },
  queue: { pending_events: 0, oldest_unindexed_age_s: 0 },
  index: { ready: false, model: null },
};

describe('the kill of memhub stop', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports the exit code when taskkill says nothing', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    vi.mocked(spawnSync)
      .mockReset()
      .mockReturnValue({ status: 5, stderr: null } as unknown as ReturnType<typeof spawnSync>);

    expect(() => killProcessTree(4321)).toThrow('taskkill failed for pid 4321: exit code 5');
  });
});

describe('the data directory of memhub stop', () => {
  const homes: string[] = [];

  beforeEach(() => {
    const home = mkdtempSync(join(tmpdir(), 'memhub-stop-home-'));
    homes.push(home);
    writeFileSync(join(home, 'token'), 'stop-token');
    vi.stubEnv(MEMHUB_HOME_ENV, home);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(healthBody), { status: 200 }))
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    for (const home of homes.splice(0)) {
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it('takes the token from the data directory of the environment', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    let probes = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        const path = String(url);
        if (path.endsWith('/healthz')) {
          probes += 1;
          if (probes === 1) return new Response(JSON.stringify(healthBody), { status: 200 });
          throw new Error('ECONNREFUSED');
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      })
    );

    const code = await runStopCommand({ port: 7800 });

    expect(code).toBe(0);
    expect(log.mock.calls.flat().join('\n')).toContain('MemHub server stopped');
  });
});

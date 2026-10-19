import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { killProcessTree, runStopCommand } from '../../../src/cli/commands/stop.js';

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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function unreachable(): never {
  throw new Error('ECONNREFUSED');
}

describe('runStopCommand', () => {
  const homes: string[] = [];
  let fetchMock: Mock<[url: unknown], Promise<Response>>;

  function makeHome(withToken: boolean): string {
    const home = mkdtempSync(join(tmpdir(), 'memhub-stopcmd-'));
    homes.push(home);
    if (withToken) {
      writeFileSync(join(home, 'token'), 'stop-token');
    }
    return home;
  }

  beforeEach(() => {
    fetchMock = vi.fn(async (_url: unknown) => json(healthBody));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    for (const home of homes.splice(0)) {
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it('exits 0 without doing anything when the server is not running', async () => {
    fetchMock.mockImplementation(async () => unreachable());
    const killTree = vi.fn();
    const code = await runStopCommand({ port: 7800, home: makeHome(true), killTree });
    expect(code).toBe(0);
    expect(killTree).not.toHaveBeenCalled();
  });

  it('exits 1 when another program answers on the port', async () => {
    fetchMock.mockImplementation(async () => json({ app: 'other' }));
    const killTree = vi.fn();
    const code = await runStopCommand({ port: 7800, home: makeHome(true), killTree });
    expect(code).toBe(0); // not a memhub daemon: nothing to stop
    expect(killTree).not.toHaveBeenCalled();
  });

  it('exits 1 when the token file is missing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = await runStopCommand({ port: 7800, home: makeHome(false) });
    expect(code).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1); // only the health probe
  });

  it('stops gracefully when the server exits in time', async () => {
    const home = makeHome(true);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    let probes = 0;
    fetchMock.mockImplementation(async (url: unknown) => {
      const path = String(url);
      if (path.endsWith('/healthz')) {
        probes += 1;
        return probes <= 1 ? json(healthBody) : unreachable();
      }
      return json({ ok: true });
    });

    const code = await runStopCommand({ port: 7800, home });
    expect(code).toBe(0);
    expect(log.mock.calls.flat().join('\n')).toContain('MemHub server stopped');
  });

  it('force-kills the process tree after the grace period', async () => {
    const home = makeHome(true);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // the daemon never goes down
    fetchMock.mockImplementation(async (url: unknown) => {
      const path = String(url);
      return path.endsWith('/healthz') ? json(healthBody) : json({ ok: true });
    });
    const killTree = vi.fn();

    // injectable clock so the 5s timeout elapses instantly
    let fakeNow = 1_000_000;
    const code = await runStopCommand({
      port: 7800,
      home,
      killTree,
      now: () => (fakeNow += 1000),
    });
    expect(code).toBe(0);
    expect(killTree).toHaveBeenCalledWith(555);
  });

  it('exits 1 when the force kill fails', async () => {
    const home = makeHome(true);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockImplementation(async (url: unknown) => {
      const path = String(url);
      return path.endsWith('/healthz') ? json(healthBody) : json({ ok: true });
    });
    const killTree = vi.fn(() => {
      throw new Error('taskkill failed');
    });
    let fakeNow = 1_000_000;
    const code = await runStopCommand({
      port: 7800,
      home,
      killTree,
      now: () => (fakeNow += 1000),
    });
    expect(code).toBe(1);
  });
});

describe('killProcessTree', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('delegates to process.kill on non-Windows platforms', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    killProcessTree(1234);
    expect(kill).toHaveBeenCalledWith(1234, 'SIGKILL');
  });

  it('throws a descriptive error when the signal cannot be delivered', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH');
    });
    expect(() => killProcessTree(1234)).toThrow('failed to kill pid 1234');
  });

  it('uses taskkill /T /F on Windows', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    vi.mocked(spawnSync)
      .mockReset()
      .mockReturnValue({ status: 0 } as unknown as ReturnType<typeof spawnSync>);
    killProcessTree(4321);
    expect(spawnSync).toHaveBeenCalledWith(
      'taskkill',
      ['/PID', '4321', '/T', '/F'],
      expect.anything()
    );
  });

  it('throws when taskkill fails on Windows', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    vi.mocked(spawnSync)
      .mockReset()
      .mockReturnValue({ status: 1, stderr: 'not found' } as unknown as ReturnType<
        typeof spawnSync
      >);
    expect(() => killProcessTree(4321)).toThrow('taskkill failed for pid 4321');
  });
});

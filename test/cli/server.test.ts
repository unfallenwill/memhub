import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  handleAddressInUse,
  parseServerArgs,
  runServerCommand,
  waitForServer,
} from '../../src/cli/server.js';
import { PortInUseError, startDaemon } from '../../src/daemon/start.js';
import { MEMHUB_HOME_ENV, PORT_ENV } from '../../src/paths.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn() };
});

vi.mock('../../src/daemon/start.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/daemon/start.js')>();
  return {
    ...actual,
    startDaemon: vi.fn(),
    PortInUseError: class PortInUseError extends Error {
      constructor(public readonly port: number) {
        super(`port ${port} is already in use`);
        this.name = 'PortInUseError';
      }
    },
  };
});

const healthBody = {
  app: 'memhub',
  pid: 777,
  uptime: 42,
  version: '1.0.0',
  cards: { total: 3, active: 2, pending_index: 1 },
  queue: { pending_events: 1, oldest_unindexed_age_s: 5 },
  index: { ready: false, model: null },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function unreachable(): never {
  throw new Error('ECONNREFUSED');
}

function fakeChild(): ReturnType<typeof spawn> {
  return { unref: vi.fn() } as unknown as ReturnType<typeof spawn>;
}

describe('parseServerArgs', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to background on port 7800', () => {
    expect(parseServerArgs([])).toEqual({ port: 7800, foreground: false });
  });

  it('defaults the port to MEMHUB_PORT', () => {
    vi.stubEnv(PORT_ENV, '9000');
    expect(parseServerArgs([])).toEqual({ port: 9000, foreground: false });
  });

  it('--port overrides MEMHUB_PORT', () => {
    vi.stubEnv(PORT_ENV, '9000');
    expect(parseServerArgs(['--port', '9001'])).toEqual({ port: 9001, foreground: false });
  });

  it('rejects an invalid MEMHUB_PORT', () => {
    vi.stubEnv(PORT_ENV, 'not-a-port');
    expect(() => parseServerArgs([])).toThrow(/MEMHUB_PORT/);
  });

  it('parses --port and --foreground in both long and short forms', () => {
    expect(parseServerArgs(['--port', '9000', '--foreground'])).toEqual({
      port: 9000,
      foreground: true,
    });
    expect(parseServerArgs(['-p', '9001', '-f'])).toEqual({ port: 9001, foreground: true });
  });

  it('rejects invalid ports and unknown options', () => {
    for (const argv of [['--port'], ['--port', 'abc'], ['--port', '0'], ['--wat']]) {
      expect(() => parseServerArgs(argv), argv.join(' ')).toThrow();
    }
  });
});

describe('handleAddressInUse', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('exit 0 when the port is served by a memhub daemon', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(healthBody))
    );
    expect(await handleAddressInUse(7800)).toBe(0);
  });

  it('exit 1 when another program holds the port', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ other: true }))
    );
    expect(await handleAddressInUse(7800)).toBe(1);
  });

  it('exit 1 when nothing responds on the port', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => unreachable())
    );
    expect(await handleAddressInUse(7800)).toBe(1);
  });
});

describe('waitForServer', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns as soon as a daemon answers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(healthBody))
    );
    const probe = await waitForServer(7800, 1000);
    expect(probe.kind).toBe('memhub');
  });

  it('times out when nothing answers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => unreachable())
    );
    const probe = await waitForServer(7800, 10, 5);
    expect(probe.kind).toBe('unreachable');
  });
});

describe('runServerCommand', () => {
  const homes: string[] = [];
  let originalArgv1: string | undefined;

  beforeEach(() => {
    const home = mkdtempSync(join(tmpdir(), 'memhub-servercmd-'));
    homes.push(home);
    vi.stubEnv(MEMHUB_HOME_ENV, home);
    originalArgv1 = process.argv[1];
    process.argv[1] = join(home, 'cli-entry.js');
    vi.mocked(startDaemon).mockReset();
    vi.mocked(spawn)
      .mockReset()
      .mockImplementation(() => fakeChild());
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    process.argv[1] = originalArgv1;
    for (const home of homes.splice(0)) {
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it('foreground: exits 0 when the port is already a memhub daemon', async () => {
    vi.mocked(startDaemon).mockRejectedValue(new PortInUseError(7800));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(healthBody))
    );

    const code = await runServerCommand({ port: 7800, foreground: true });
    expect(code).toBe(0);
  });

  it('foreground: exits 1 when the port is held by another program', async () => {
    vi.mocked(startDaemon).mockRejectedValue(new PortInUseError(7800));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ nope: true }))
    );

    const code = await runServerCommand({ port: 7800, foreground: true });
    expect(code).toBe(1);
  });

  it('foreground: closes the daemon and exits 0 after a stop request', async () => {
    let resolveClosed: () => void = () => {};
    const closed = new Promise<void>(resolve => {
      resolveClosed = resolve;
    });
    const close = vi.fn(async () => resolveClosed());
    vi.mocked(startDaemon).mockResolvedValue({
      port: 7800,
      pid: 123,
      closed,
      close,
    });

    const codePromise = runServerCommand({ port: 7800, foreground: true });
    // give the command a tick to settle, then stop the daemon
    await new Promise(resolve => setTimeout(resolve, 20));
    await close();
    expect(await codePromise).toBe(0);
  });

  it('background: spawns a detached child and waits for healthz', async () => {
    // First probe (pre-start check) finds nothing; after the child is
    // spawned, healthz answers.
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => (++calls === 1 ? unreachable() : json(healthBody)))
    );

    const code = await runServerCommand({ port: 7800, foreground: false });
    expect(code).toBe(0);
    expect(spawn).toHaveBeenCalledTimes(1);
    const [command, args, options] = vi.mocked(spawn).mock.calls[0] as unknown as [
      string,
      string[],
      { detached: boolean; windowsHide: boolean },
    ];
    expect(command).toBe(process.execPath);
    expect(args).toEqual([
      join(homes[0], 'cli-entry.js'),
      'server',
      '--port',
      '7800',
      '--foreground',
    ]);
    expect(options.detached).toBe(true);
    expect(options.windowsHide).toBe(true);
  });

  it('background: exits 1 when another program answers on the port', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ hello: true }))
    );

    const code = await runServerCommand({ port: 7800, foreground: false });
    expect(code).toBe(1);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('background: reports already running without spawning when a daemon owns the port', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(healthBody))
    );

    const code = await runServerCommand({ port: 7800, foreground: false });
    expect(code).toBe(0);
    expect(spawn).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join('\n')).toContain('already running');
    expect(log.mock.calls.flat().join('\n')).toContain('777');
  });

  it('background: exits 1 when the daemon never becomes healthy', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => unreachable())
    );

    const code = await runServerCommand({
      port: 7800,
      foreground: false,
      startupTimeoutMs: 150,
    });
    expect(code).toBe(1);
  });
});

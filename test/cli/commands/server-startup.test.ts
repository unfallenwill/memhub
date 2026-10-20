/**
 * The startup paths of `memhub server` (src/cli/commands/server.ts).
 *
 * The command either spawns a detached daemon or runs one in the
 * foreground. This file covers the paths around that: a daemon that
 * fails for a reason other than a port conflict, the signal handler
 * that stops the foreground daemon, a missing CLI entry path and the
 * port that another program takes in the meantime.
 */

import { mkdtempSync, rmSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runServerCommand } from '../../../src/cli/commands/server.js';
import { realPath } from '../../../src/cli/entry.js';
import { startDaemon } from '../../../src/daemon/start.js';
import { MEMHUB_HOME_ENV } from '../../../src/paths.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
/** The script the `memhub` bin points at. */
const cliEntry = join(repoRoot, 'src', 'cli', 'index.ts');

/**
 * A path that reaches the CLI entry script through a symlink.
 *
 * Windows only grants the privilege a *file* symlink needs to some
 * installations, so the fallback links the directory instead - a
 * junction needs no privilege at all. Returns null when the platform
 * refuses both.
 */
function linkToCliEntry(): string | null {
  const dir = mkdtempSync(join(tmpdir(), 'memhub-server-link-'));
  const fileLink = join(dir, `file-${basename(cliEntry)}`);
  try {
    symlinkSync(cliEntry, fileLink, 'file');
    return fileLink;
  } catch {
    // No file symlink on this machine: try the directory below.
  }
  const dirLink = join(dir, 'dir-link');
  try {
    symlinkSync(dirname(cliEntry), dirLink, process.platform === 'win32' ? 'junction' : 'dir');
    return join(dirLink, basename(cliEntry));
  } catch {
    return null;
  }
}

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn() };
});

vi.mock('../../../src/daemon/start.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../src/daemon/start.js')>();
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

describe('the startup paths of memhub server', () => {
  const homes: string[] = [];
  let originalArgv1: string | undefined;

  beforeEach(() => {
    const home = mkdtempSync(join(tmpdir(), 'memhub-server-startup-'));
    homes.push(home);
    vi.stubEnv(MEMHUB_HOME_ENV, home);
    originalArgv1 = process.argv[1];
    process.argv[1] = join(home, 'cli-entry.js');
    vi.mocked(startDaemon).mockReset();
    vi.mocked(spawn)
      .mockReset()
      .mockImplementation(() => ({ unref: vi.fn() }) as unknown as ReturnType<typeof spawn>);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (originalArgv1 !== undefined) process.argv[1] = originalArgv1;
    for (const home of homes.splice(0)) {
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it('foreground: rethrows a daemon failure that is not a port conflict', async () => {
    vi.mocked(startDaemon).mockRejectedValue(new Error('the model directory is not writable'));

    await expect(runServerCommand({ port: 7800, foreground: true })).rejects.toThrow(
      'the model directory is not writable'
    );
  });

  it('foreground: stops the daemon when the process is asked to quit', async () => {
    let resolveClosed: () => void = () => {};
    const closed = new Promise<void>(resolve => {
      resolveClosed = resolve;
    });
    const close = vi.fn(async () => resolveClosed());
    vi.mocked(startDaemon).mockResolvedValue({
      host: '127.0.0.1',
      port: 7800,
      pid: 123,
      closed,
      close,
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const known = new Set(process.listeners('SIGINT'));
    const codePromise = runServerCommand({ port: 7800, foreground: true });
    await new Promise(resolve => setTimeout(resolve, 20));

    const added = process.listeners('SIGINT').filter(listener => !known.has(listener));
    expect(added).toHaveLength(1);
    (added[0] as () => void)();

    expect(await codePromise).toBe(0);
    expect(close).toHaveBeenCalled();
    // The handler is removed again when the daemon is gone.
    expect(process.listeners('SIGINT').filter(listener => !known.has(listener))).toHaveLength(0);
  });

  it('background: fails when the CLI entry path is unknown', async () => {
    process.argv[1] = undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => unreachable())
    );

    await expect(runServerCommand({ port: 7800, foreground: false })).rejects.toThrow(
      'cannot determine CLI entry path'
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it('background: spawns the daemon from the real path of the entry script', async () => {
    // Under a symlinked install (npm bin-links) process.argv[1] is the
    // symlink. The child has to be started from the real file, otherwise
    // it does not recognize itself as the entry point and the daemon
    // never comes up.
    const link = linkToCliEntry();
    if (link === null) {
      throw new Error('this platform supports neither file symlinks nor directory junctions');
    }
    process.argv[1] = link;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => unreachable())
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const code = await runServerCommand({
      port: 7800,
      foreground: false,
      startupTimeoutMs: 50,
    });

    expect(code).toBe(1);
    expect(spawn).toHaveBeenCalledTimes(1);
    const [, args] = vi.mocked(spawn).mock.calls[0] as [string, string[]];
    // The child is started from the real path, not from the symlink.
    expect(args[0]).toBe(realPath(cliEntry));
    expect(args[0]).not.toBe(link);
  });

  it('background: reports the port as taken when another program answers', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        // The pre-start probe finds nothing, the port is taken while the
        // daemon starts.
        return calls === 1 ? unreachable() : json({ someOtherServer: true });
      })
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const code = await runServerCommand({ port: 7800, foreground: false });

    expect(code).toBe(1);
    expect(error.mock.calls.flat().join('\n')).toContain('is already in use by another program');
  });
});

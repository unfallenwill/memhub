/**
 * Characterization test: the CLI output contract.
 *
 * The CLI is the machine-facing surface of MemHub: agents parse its
 * stdout and branch on its exit code. The entry point (argument
 * dispatch, help, version, unknown command) and the individual commands
 * are pinned here so a refactor cannot silently change what an agent
 * sees.
 *
 * The entry point exports `run(argv)` and only executes itself when it
 * is the process entry point, so the CLI is exercised in-process with
 * a fresh module registry per invocation.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getVersion } from '../../src/version.js';
import { runAddCommand } from '../../src/cli/commands/add.js';
import { runConfigCommand } from '../../src/cli/commands/config.js';
import { runLoginCommand } from '../../src/cli/commands/login.js';
import { runLogoutCommand } from '../../src/cli/commands/logout.js';
import { runSearchCommand } from '../../src/cli/commands/search.js';
import { runStatusCommand } from '../../src/cli/commands/status.js';

/** The exit code the CLI process would end with. */
type ExitCode = number | string | null | undefined;

interface CliRun {
  readonly code: ExitCode;
  readonly stdout: string;
  readonly stderr: string;
  /** Number of console.log calls (one line of output each). */
  readonly stdoutLines: number;
}

/** The exit code the test process had before the CLI ran. */
const ORIGINAL_EXIT_CODE: ExitCode = process.exitCode;

/**
 * Run the CLI entry point with the given arguments and capture its
 * output. The module registry is reset so the entry point is loaded
 * afresh.
 */
async function runCli(args: readonly string[]): Promise<CliRun> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => {
    stdout.push(parts.map(part => String(part)).join(' '));
  });
  const errorSpy = vi.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => {
    stderr.push(parts.map(part => String(part)).join(' '));
  });
  const argvBackup = process.argv;
  process.argv = ['node', 'memhub', ...args];
  vi.resetModules();
  try {
    const { run } = await import('../../src/cli/index.js');
    const code = await run(args);
    return {
      code,
      stdout: stdout.join('\n'),
      stderr: stderr.join('\n'),
      stdoutLines: stdout.length,
    };
  } finally {
    process.argv = argvBackup;
    process.exitCode = ORIGINAL_EXIT_CODE;
    logSpy.mockRestore();
    errorSpy.mockRestore();
  }
}

describe('CLI entry point', () => {
  afterEach(() => {
    process.exitCode = ORIGINAL_EXIT_CODE;
    vi.restoreAllMocks();
  });

  it('exits 1 and prints the usage when no command is given', async () => {
    const run = await runCli([]);
    expect(run.code).toBe(1);
    expect(run.stdout).toContain('Usage:');
    expect(run.stdout).toContain('memhub server');
    expect(run.stderr).toBe('');
  });

  it('exits 0 for --help and prints the usage on stdout', async () => {
    for (const flag of ['--help', '-h']) {
      const run = await runCli([flag]);
      expect(run.code, flag).toBe(0);
      expect(run.stdout, flag).toContain('Usage:');
      expect(run.stdout, flag).toContain('memhub add');
      expect(run.stdout, flag).toContain('memhub search');
      expect(run.stderr, flag).toBe('');
    }
  });

  it('exits 0 for --version and prints the version on stdout', async () => {
    for (const flag of ['--version', '-v']) {
      const run = await runCli([flag]);
      expect(run.code, flag).toBe(0);
      expect(run.stdout.trim(), flag).toBe(`MemHub CLI v${getVersion()}`);
      expect(run.stderr, flag).toBe('');
    }
  });

  it('exits 1 and reports an unknown command on stderr', async () => {
    const run = await runCli(['bogus']);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('Unknown command');
    expect(run.stderr).toContain('bogus');
    expect(run.stderr).toContain('memhub --help');
    expect(run.stdout).toBe('');
  });

  it('exits 1 and reports a bad option on stderr', async () => {
    const run = await runCli(['status', '--nope']);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('unknown option for status');
  });

  it('exits 1 when a command is missing its required argument', async () => {
    const run = await runCli(['add']);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('--title is required');
  });
});

describe('CLI command output', () => {
  const homes: string[] = [];

  function makeHome(): string {
    const home = mkdtempSync(join(tmpdir(), 'memhub-cli-contract-'));
    homes.push(home);
    writeFileSync(join(home, 'token'), 'test-token');
    return home;
  }

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    while (homes.length > 0) {
      const home = homes.pop();
      if (home !== undefined) rmSync(home, { recursive: true, force: true });
    }
  });

  describe('memhub status', () => {
    it('prints the daemon details and exits 0 when the daemon answers', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                app: 'memhub',
                pid: 4321,
                uptime: 120,
                version: '1.0.0',
                cards: { total: 10, active: 8, pending_index: 2 },
                queue: { pending_events: 3, oldest_unindexed_age_s: 45 },
                index: { ready: false, model: null },
              }),
              { status: 200 }
            )
        )
      );

      const code = await runStatusCommand({ port: 7800 });
      expect(code).toBe(0);
      const output = log.mock.calls.flat().join('\n');
      expect(output).toContain('MemHub server is running');
      expect(output).toContain('url:     http://127.0.0.1:7800');
      expect(output).toContain('pid:     4321');
      expect(output).toContain('uptime:  120s');
      expect(output).toContain('version: 1.0.0');
      expect(output).toContain('cards:   total=10 active=8 pending_index=2');
      expect(output).toContain('queue:   pending_events=3 oldest_unindexed_age_s=45');
      expect(output).toContain('index:   not ready (model: none)');
    });

    it('prints "not running" and exits 1 when the daemon is down', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error('ECONNREFUSED');
        })
      );

      const code = await runStatusCommand({ port: 7800 });
      expect(code).toBe(1);
      expect(log.mock.calls.flat().join('\n')).toBe('MemHub server is not running');
    });
  });

  describe('memhub add', () => {
    it('prints the response as a single line of JSON and exits 0', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(JSON.stringify({ id: 7, indexed: false, deduplicated: false }), {
              status: 202,
            })
        )
      );

      const code = await runAddCommand({
        title: 'T',
        body: 'B',
        type: 'insight',
        cues: [],
        writer: undefined,
        port: 7800,
        home: makeHome(),
      });

      expect(code).toBe(0);
      expect(log).toHaveBeenCalledTimes(1);
      const line = String(log.mock.calls[0]?.[0]);
      expect(line).not.toContain('\n');
      expect(JSON.parse(line)).toEqual({ id: 7, indexed: false, deduplicated: false });
    });

    it('exits 1 with an empty body', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const code = await runAddCommand({
        title: 'T',
        body: '   ',
        type: 'insight',
        cues: [],
        writer: undefined,
        port: 7800,
        home: makeHome(),
      });
      expect(code).toBe(1);
      expect(error.mock.calls.flat().join('\n')).toContain('empty');
    });
  });

  describe('memhub search', () => {
    it('prints the response as a single line of JSON and exits 0', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(JSON.stringify({ results: [{ id: 1 }], mode_used: 'keyword' }), {
              status: 200,
            })
        )
      );

      const code = await runSearchCommand({
        query: 'docker',
        mode: 'auto',
        limit: 10,
        port: 7800,
        home: makeHome(),
      });

      expect(code).toBe(0);
      expect(log).toHaveBeenCalledTimes(1);
      const line = String(log.mock.calls[0]?.[0]);
      expect(line).not.toContain('\n');
      expect(JSON.parse(line)).toEqual({ results: [{ id: 1 }], mode_used: 'keyword' });
    });

    it('exits 1 and reports the error code from the API', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'nope' } }), {
              status: 401,
            })
        )
      );

      const code = await runSearchCommand({
        query: 'docker',
        mode: 'auto',
        limit: 10,
        port: 7800,
        home: makeHome(),
      });
      expect(code).toBe(1);
      expect(error.mock.calls.flat().join('\n')).toContain('unauthorized');
    });
  });

  describe('memhub config', () => {
    it('sets, reads, lists and unsets the base-url', () => {
      const home = makeHome();
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});

      expect(
        runConfigCommand({ action: 'set', key: 'base-url', value: 'https://x.example', home })
      ).toBe(0);
      expect(log.mock.calls.flat().join('\n')).toContain('base-url = https://x.example');

      expect(runConfigCommand({ action: 'get', key: 'base-url', home })).toBe(0);
      expect(runConfigCommand({ action: 'list', home })).toBe(0);
      expect(log.mock.calls.flat().join('\n')).toContain('base-url=https://x.example');

      expect(runConfigCommand({ action: 'unset', key: 'base-url', home })).toBe(0);
      expect(log.mock.calls.flat().join('\n')).toContain('base-url unset');
    });

    it('exits 1 when the key is not set', () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const code = runConfigCommand({ action: 'get', key: 'base-url', home: makeHome() });
      expect(code).toBe(1);
      expect(error.mock.calls.flat().join('\n')).toContain('base-url is not set');
    });

    it('exits 1 for an invalid base URL', () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const code = runConfigCommand({
        action: 'set',
        key: 'base-url',
        value: 'ftp://x.example',
        home: makeHome(),
      });
      expect(code).toBe(1);
      expect(error.mock.calls.flat().join('\n')).toContain('invalid base URL');
    });
  });

  describe('memhub logout', () => {
    it('prints "Not logged in." and exits 0 without credentials', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const code = await runLogoutCommand({ home: makeHome() });
      expect(code).toBe(0);
      expect(log.mock.calls.flat().join('\n')).toBe('Not logged in.');
    });
  });

  describe('memhub login', () => {
    it('exits 1 with a usage hint when no base URL is configured', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const code = await runLoginCommand({ home: makeHome() });
      expect(code).toBe(1);
      expect(error.mock.calls.flat().join('\n')).toContain('usage: memhub login --base-url <url>');
    });
  });
});

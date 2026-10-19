/**
 * `memhub stop` command.
 *
 * Asks the daemon to shut down gracefully via POST /api/shutdown (with
 * the token from ~/.memhub/token). If it is still alive after a 5 second
 * grace period, the process tree is killed: taskkill /T /F on Windows,
 * SIGKILL elsewhere.
 */

import { spawnSync } from 'node:child_process';
import { sleep } from '../../core/util/sleep.js';
import { resolveExistingToken } from '../../daemon/token.js';
import { getDefaultPort, getMemhubHome, getTokenPath } from '../../paths.js';
import { postShutdown, probeHealthz } from '../client.js';
import { parseFlags, parsePortValue, PORT_FLAG } from '../options.js';
import type { CommandImplementation } from '../types.js';

/** How long to wait for a graceful shutdown before force-killing. */
export const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 5000;

/** Options for the stop command. */
export interface StopCommandOptions {
  readonly port: number;
  /** Injected for tests; defaults to the platform kill implementation. */
  readonly killTree?: ((pid: number) => void) | undefined;
  /** Data directory override (tests). */
  readonly home?: string | undefined;
  /** Clock override (tests). */
  readonly now?: (() => number) | undefined;
}

/** Parse `memhub stop` arguments. Throws on invalid input. */
export function parseStopArgs(argv: readonly string[]): StopCommandOptions {
  const flags = parseFlags(argv, [PORT_FLAG]);
  let port = getDefaultPort();
  for (const entry of flags.entries) {
    switch (entry.name) {
      case '--port':
        port = parsePortValue(entry.value);
        break;
      default:
        throw new Error(`unknown option for stop: ${entry.arg}`);
    }
  }
  return { port };
}

/** Kill a process tree: taskkill /T /F on Windows, SIGKILL elsewhere. */
export function killProcessTree(pid: number): void {
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf-8' });
    if (result.status !== 0) {
      throw new Error(
        `taskkill failed for pid ${pid}: ${result.stderr ?? `exit code ${result.status}`}`
      );
    }
  } else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch (error) {
      throw new Error(`failed to kill pid ${pid}: ${String(error)}`);
    }
  }
}

/** Run the stop command. Returns the process exit code. */
export async function runStopCommand(options: StopCommandOptions): Promise<number> {
  const killTree = options.killTree ?? killProcessTree;
  const now = options.now ?? Date.now;

  const probe = await probeHealthz(options.port);
  if (probe.kind !== 'memhub') {
    // eslint-disable-next-line no-console
    console.log('MemHub server is not running');
    return 0;
  }
  const pid = probe.info.pid;

  const token = resolveExistingToken(getTokenPath(options.home ?? getMemhubHome()));
  if (token === null) {
    // eslint-disable-next-line no-console
    console.error('Cannot read the MemHub token file; cannot request a graceful shutdown');
    return 1;
  }

  const accepted = await postShutdown(options.port, token);
  if (accepted) {
    // eslint-disable-next-line no-console
    console.log('Shutdown requested, waiting for the server to exit...');
  }

  const deadline = now() + GRACEFUL_SHUTDOWN_TIMEOUT_MS;
  while (now() < deadline) {
    const check = await probeHealthz(options.port, 1000);
    if (check.kind === 'unreachable') {
      // eslint-disable-next-line no-console
      console.log('MemHub server stopped');
      return 0;
    }
    await sleep(200);
  }

  // Still alive: force kill the process tree.
  try {
    killTree(pid);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(String(error));
    return 1;
  }
  // eslint-disable-next-line no-console
  console.log(`MemHub server killed (pid ${pid})`);
  return 0;
}

/** The stop command, as the registry sees it. */
export const stopCommand: CommandImplementation<StopCommandOptions> = {
  parse: parseStopArgs,
  run: runStopCommand,
};

/**
 * `memhub server` command.
 *
 * Default: spawn a detached background daemon with logs redirected to
 * ~/.memhub/logs/. --foreground runs the daemon in the current process.
 * If the port is taken, probe /healthz: a MemHub daemon means "already
 * running" (exit 0), anything else suggests --port (exit 1).
 */

import { mkdirSync, openSync } from 'fs';
import { spawn } from 'node:child_process';
import { sleep } from '../../core/util/sleep.js';
import { getBindHost, getDefaultPort, getLogsDir, getMemhubHome } from '../../paths.js';
import { probeHealthz, type HealthProbe } from '../client.js';
import { cliEntryPath } from '../entry.js';
import { parseFlags, parsePortValue, PORT_FLAG, type FlagSpec } from '../options.js';
import type { CommandImplementation } from '../types.js';

/** Options for the server command. */
export interface ServerCommandOptions {
  readonly port: number;
  readonly foreground: boolean;
  /** How long to wait for a background daemon to become healthy. */
  readonly startupTimeoutMs?: number | undefined;
}

/** The flags `memhub server` understands. */
const SERVER_FLAGS: readonly FlagSpec[] = [PORT_FLAG, { name: '--foreground', aliases: ['-f'] }];

/** Parse `memhub server` arguments. Throws on invalid input. */
export function parseServerArgs(argv: readonly string[]): ServerCommandOptions {
  const flags = parseFlags(argv, SERVER_FLAGS);
  let port = getDefaultPort();
  let foreground = false;
  for (const entry of flags.entries) {
    switch (entry.name) {
      case '--port':
        port = parsePortValue(entry.value);
        break;
      case '--foreground':
        foreground = true;
        break;
      default:
        throw new Error(`unknown option: ${entry.arg}`);
    }
  }
  return { port, foreground };
}

/** Run the server command. Returns the process exit code. */
export async function runServerCommand(options: ServerCommandOptions): Promise<number> {
  if (options.foreground) {
    return runForeground(options.port);
  }
  return runBackground(options.port, options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS);
}

/** Default time to wait for a background daemon to become healthy. */
export const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;

async function runForeground(port: number): Promise<number> {
  // The daemon pulls in Hono, Zod and SQLite: load it only when the
  // command really starts a server.
  const { startDaemon, PortInUseError } = await import('../../daemon/start.js');
  let handle: Awaited<ReturnType<typeof startDaemon>> | undefined;
  try {
    handle = await startDaemon({ port });
  } catch (error) {
    if (error instanceof PortInUseError) {
      return handleAddressInUse(port);
    }
    throw error;
  }
  const running = handle;
  // eslint-disable-next-line no-console
  console.log(
    `MemHub server listening on http://${running.host}:${running.port} (pid ${running.pid})`
  );

  const shutdown = (): void => {
    void running.close();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await running.closed;
  process.removeListener('SIGINT', shutdown);
  process.removeListener('SIGTERM', shutdown);
  return 0;
}

async function runBackground(port: number, startupTimeoutMs: number): Promise<number> {
  // Do not spawn anything when a daemon (or another program) already owns
  // the port - matches the EADDRINUSE behavior of the foreground path.
  const initial = await probeHealthz(port);
  if (initial.kind === 'memhub') {
    // eslint-disable-next-line no-console
    console.log(
      `MemHub server is already running (pid ${initial.info.pid}, uptime ${initial.info.uptime}s)`
    );
    return 0;
  }
  if (initial.kind === 'other') {
    // eslint-disable-next-line no-console
    console.error(
      `Port ${port} is already in use by another program. Start with --port to pick a different port.`
    );
    return 1;
  }

  const home = getMemhubHome();
  const logsDir = getLogsDir(home);
  mkdirSync(logsDir, { recursive: true });
  const outFd = openSync(`${logsDir}/server.log`, 'a');
  const errFd = openSync(`${logsDir}/server-error.log`, 'a');

  // The child is started from the *real* path of this script: under a
  // symlinked install (npm bin-links) process.argv[1] is the symlink,
  // and the child would otherwise not recognize itself as the entry
  // point and exit silently.
  const cliEntry = cliEntryPath();
  const child = spawn(
    process.execPath,
    [cliEntry, 'server', '--port', String(port), '--foreground'],
    {
      detached: true,
      stdio: ['ignore', outFd, errFd],
      windowsHide: true,
    }
  );
  child.unref();

  const probe = await waitForServer(port, startupTimeoutMs);
  if (probe.kind === 'memhub') {
    // eslint-disable-next-line no-console
    console.log(`MemHub server started (pid ${probe.info.pid}) on http://${getBindHost()}:${port}`);
    return 0;
  }
  if (probe.kind === 'other') {
    // eslint-disable-next-line no-console
    console.error(
      `Port ${port} is already in use by another program. Start with --port to pick a different port.`
    );
    return 1;
  }
  // eslint-disable-next-line no-console
  console.error(
    `MemHub server failed to start within ${Math.round(startupTimeoutMs / 1000)}s. Check the logs at ${logsDir}/server-error.log`
  );
  return 1;
}

/**
 * EADDRINUSE handling: if the port is served by a MemHub daemon, report
 * "already running" (exit 0); otherwise suggest another port (exit 1).
 */
export async function handleAddressInUse(port: number): Promise<number> {
  const probe = await probeHealthz(port);
  if (probe.kind === 'memhub') {
    // eslint-disable-next-line no-console
    console.log(
      `MemHub server is already running (pid ${probe.info.pid}, uptime ${probe.info.uptime}s)`
    );
    return 0;
  }
  if (probe.kind === 'other') {
    // eslint-disable-next-line no-console
    console.error(
      `Port ${port} is already in use by another program. Start with --port to pick a different port.`
    );
    return 1;
  }
  // eslint-disable-next-line no-console
  console.error(
    `Port ${port} is in use but did not respond. Start with --port to pick a different port.`
  );
  return 1;
}

/** Poll /healthz until the daemon answers, another program answers, or we time out. */
export async function waitForServer(
  port: number,
  timeoutMs: number,
  intervalMs = 200
): Promise<HealthProbe> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const probe = await probeHealthz(port);
    if (probe.kind !== 'unreachable') return probe;
    if (Date.now() >= deadline) return probe;
    await sleep(intervalMs);
  }
}

/** The server command, as the registry sees it. */
export const serverCommand: CommandImplementation<ServerCommandOptions> = {
  parse: parseServerArgs,
  run: runServerCommand,
};

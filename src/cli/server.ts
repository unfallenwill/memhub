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
import { startDaemon, PortInUseError } from '../daemon/start.js';
import { getLogsDir, getMemhubHome } from '../paths.js';
import { probeHealthz, type HealthProbe } from './client.js';

/** Options for the server command. */
export interface ServerCommandOptions {
  readonly port: number;
  readonly foreground: boolean;
  /** How long to wait for a background daemon to become healthy. */
  readonly startupTimeoutMs?: number | undefined;
}

/** Parse `memhub server` arguments. Throws on invalid input. */
export function parseServerArgs(argv: readonly string[]): ServerCommandOptions {
  let port = 7800;
  let foreground = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--foreground' || arg === '-f') {
      foreground = true;
    } else if (arg === '--port' || arg === '-p') {
      const value = argv[++i];
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
        throw new Error(`invalid --port value: ${value ?? '(missing)'}`);
      }
      port = parsed;
    } else {
      throw new Error(`unknown option: ${arg}`);
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
  console.log(`MemHub server listening on http://127.0.0.1:${running.port} (pid ${running.pid})`);

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

  const cliEntry = process.argv[1];
  if (!cliEntry) {
    throw new Error('cannot determine CLI entry path');
  }
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
    console.log(`MemHub server started (pid ${probe.info.pid}) on http://127.0.0.1:${port}`);
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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

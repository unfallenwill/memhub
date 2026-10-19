/**
 * `memhub status` command.
 *
 * Pings GET /healthz and prints pid, uptime, card statistics and queue
 * backlog.
 */

import { getDefaultPort } from '../../paths.js';
import { probeHealthz } from '../client.js';
import { parseFlags, parsePortValue, PORT_FLAG } from '../options.js';
import type { CommandImplementation } from '../types.js';

/** Options for the status command. */
export interface StatusCommandOptions {
  readonly port: number;
}

/** Parse `memhub status` arguments. Throws on invalid input. */
export function parseStatusArgs(argv: readonly string[]): StatusCommandOptions {
  const flags = parseFlags(argv, [PORT_FLAG]);
  let port = getDefaultPort();
  for (const entry of flags.entries) {
    switch (entry.name) {
      case '--port':
        port = parsePortValue(entry.value);
        break;
      default:
        throw new Error(`unknown option for status: ${entry.arg}`);
    }
  }
  return { port };
}

/** Run the status command. Returns the process exit code. */
export async function runStatusCommand(options: StatusCommandOptions): Promise<number> {
  const probe = await probeHealthz(options.port);
  if (probe.kind !== 'memhub') {
    // eslint-disable-next-line no-console
    console.log('MemHub server is not running');
    return 1;
  }
  const info = probe.info;
  // eslint-disable-next-line no-console
  console.log(`MemHub server is running
  url:     http://127.0.0.1:${options.port}
  pid:     ${info.pid}
  uptime:  ${info.uptime}s
  version: ${info.version}
  cards:   total=${info.cards.total} active=${info.cards.active} pending_index=${info.cards.pending_index}
  queue:   pending_events=${info.queue.pending_events} oldest_unindexed_age_s=${info.queue.oldest_unindexed_age_s}
  index:   ${info.index.ready ? 'ready' : 'not ready'} (model: ${info.index.model ?? 'none'})`);
  return 0;
}

/** The status command, as the registry sees it. */
export const statusCommand: CommandImplementation<StatusCommandOptions> = {
  parse: parseStatusArgs,
  run: runStatusCommand,
};

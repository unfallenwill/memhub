/**
 * `memhub status` command.
 *
 * Pings GET /healthz and prints pid, uptime, card statistics and queue
 * backlog.
 */

import { probeHealthz } from './client.js';

/** Options for the status command. */
export interface StatusCommandOptions {
  readonly port: number;
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

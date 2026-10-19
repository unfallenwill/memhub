/**
 * The log helpers of the long-running processes.
 *
 * The daemon and the indexing worker report problems the same way, so
 * the log format of a running MemHub stays consistent.
 *
 * These helpers live in the pure utility layer and not in src/runtime/:
 * the worker sits *below* the runtime layer in the target architecture,
 * and a worker that reaches upwards for its logger would invert the
 * dependency direction. The CLI keeps its own console output (it is the
 * user interface) and the HTTP layer keeps its own error handler.
 */

import { errorMessage } from './errors.js';

/**
 * Log a failure of a daemon or worker subsystem.
 *
 * The scope names the subsystem ("indexing worker failed to start"), the
 * error is the caught value.
 */
export function logDaemonError(scope: string, error: unknown): void {
  console.error(`memhub: ${scope}: ${errorMessage(error)}`);
}

/** Log an informational message of the daemon or worker. */
export function logDaemonNotice(message: string): void {
  console.error(`memhub: ${message}`);
}

/**
 * The one sleep of the process.
 *
 * Polling loops (the worker, the CLI probes, the device flow) all wait
 * the same way; a single implementation keeps the timings comparable
 * and makes the wait injectable where a test needs it.
 */

/** Wait for the given number of milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

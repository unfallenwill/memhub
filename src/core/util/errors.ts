/**
 * Formatting of unknown thrown values.
 *
 * Every catch block in the daemon, the worker and the CLI turns an
 * unknown value into a readable message; this helper is the one
 * definition of that conversion.
 */

/** Format an unknown thrown value as a readable message. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

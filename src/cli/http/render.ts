/**
 * Rendering of daemon failures.
 *
 * The transport layer only knows how to talk HTTP; how a failure is
 * explained to the user is a presentation concern and lives here.
 */

import type { ApiPostResult } from '../client.js';

/** Context that tailors the failure hints to the daemon that was called. */
export interface ApiFailureContext {
  /** True when the request went to a remote daemon (memhub login target). */
  readonly remote?: boolean | undefined;
}

/** Print an API failure (one JSON line for agents, hints for humans). */
export function printApiFailure(
  result: ApiPostResult,
  target: string,
  context: ApiFailureContext = {}
): void {
  if (result.kind === 'unreachable') {
    console.error(
      context.remote === true
        ? `Cannot reach the MemHub daemon at ${target} — check the URL and whether the server is running.`
        : `Cannot reach the MemHub daemon at ${target} — start it with: memhub server`
    );
    return;
  }
  console.error(JSON.stringify(result.body));
  if (result.status === 401) {
    console.error(
      context.remote === true
        ? `Hint: the device token for ${target} was rejected — log in again: memhub login --base-url ${target}`
        : 'Hint: the token in ~/.memhub/token (or MEMHUB_TOKEN) must match the running daemon.'
    );
  } else if (result.status === 403) {
    console.error(
      'Hint: the daemon rejected the Host header. Add the hostname you use to MEMHUB_ALLOWED_HOSTS, or call via http://127.0.0.1.'
    );
  }
}

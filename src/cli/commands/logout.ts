/**
 * `memhub logout` command.
 *
 * Revokes the stored device token on the remote daemon and removes the
 * local credentials file. A token that is already invalid is still
 * treated as logged out (the file is removed). When the configured
 * default base-url points at the logged-out server it is unset too —
 * otherwise plain `memhub add` would fail with "not logged in".
 */

import { getMemhubHome } from '../../paths.js';
import { remoteApiFetch } from '../client.js';
import { readConfig, unsetConfigValue } from '../config-file.js';
import { deleteCredentials, normalizeBaseUrl, readCredentials } from '../credentials.js';
import { parseFlags } from '../options.js';
import type { CommandImplementation } from '../types.js';

/** Options for the logout command. */
export interface LogoutCommandOptions {
  /** Data directory override (tests). */
  readonly home?: string | undefined;
}

/** Parse `memhub logout` arguments. Throws on invalid input. */
export function parseLogoutArgs(argv: readonly string[]): LogoutCommandOptions {
  const flags = parseFlags(argv, []);
  for (const entry of flags.entries) {
    throw new Error(`unknown option for logout: ${entry.arg}`);
  }
  return {};
}

/**
 * Unset the default base-url when it routes to the logged-out server
 * (compared normalized — a hand-edited trailing slash must not escape)
 * or when it is invalid garbage.
 */
function clearConfigForLogout(home: string, serverUrl: string | null): void {
  let configured: string | undefined;
  try {
    configured = readConfig(home).base_url;
  } catch {
    // A broken config blocks `add` with its own remediation; leave it.
    return;
  }
  const normalized = configured === undefined ? undefined : normalizeBaseUrl(configured);
  if (normalized === serverUrl && serverUrl !== null) {
    unsetConfigValue(home, 'base-url');
    console.log(`Unset the default base-url (was ${serverUrl}).`);
  } else if (configured !== undefined && normalized === null) {
    unsetConfigValue(home, 'base-url');
    console.log(`Unset the invalid default base-url (was ${configured}).`);
  }
}

/** Run the logout command. Returns the process exit code. */
export async function runLogoutCommand(options: LogoutCommandOptions = {}): Promise<number> {
  const home = options.home ?? getMemhubHome();
  const stored = readCredentials(home);
  if (stored === null) {
    // Keep a valid default — flagless `memhub login` relies on it — but
    // make the leftover state visible instead of silently keeping it.
    let configured: string | undefined;
    try {
      configured = readConfig(home).base_url;
    } catch {
      // A broken config blocks `add` with its own remediation.
    }
    if (configured !== undefined) {
      console.log(`Not logged in — the default base-url is still ${configured}.`);
      console.log('Run: memhub login   (to log in to it)');
      console.log('Or:  memhub config unset base-url   (to target the local daemon)');
    } else {
      console.log('Not logged in.');
    }
    return 0;
  }
  const result = await remoteApiFetch(stored.url, stored.token, 'DELETE', '/api/auth/token');
  if (result.kind === 'unreachable') {
    console.error(`Cannot reach ${stored.url} — the credentials were kept.`);
    console.error(
      'Retry when the server is reachable, or delete ~/.memhub/credentials.json ' +
        '(and run: memhub config unset base-url, if set) to forget the token.'
    );
    return 1;
  }
  if (result.status !== 200 && result.status !== 400 && result.status !== 401) {
    console.error(`Logout failed (HTTP ${result.status}).`);
    return 1;
  }
  // Unset the config BEFORE deleting the credentials: if this write fails
  // the credentials survive and re-running logout can complete cleanly.
  clearConfigForLogout(home, stored.url);
  deleteCredentials(home);
  if (result.status === 401 || result.status === 400) {
    console.log(`Logged out from ${stored.url} (the stored token was already invalid there).`);
  } else {
    console.log(`Logged out from ${stored.url}.`);
  }
  return 0;
}

/** The logout command, as the registry sees it. */
export const logoutCommand: CommandImplementation<LogoutCommandOptions> = {
  parse: parseLogoutArgs,
  run: runLogoutCommand,
};

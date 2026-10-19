/**
 * `memhub logout` command.
 *
 * Revokes the stored device token on the remote daemon and removes the
 * local credentials file. A token that is already invalid is still
 * treated as logged out (the file is removed).
 */

import { getMemhubHome } from '../paths.js';
import { remoteApiFetch } from './client.js';
import { readCredentials, deleteCredentials } from './credentials.js';
import { readConfig, unsetConfigValue } from './config-file.js';

/** Options for the logout command. */
export interface LogoutCommandOptions {
  /** Data directory override (tests). */
  readonly home?: string | undefined;
}

/** Run the logout command. Returns the process exit code. */
export async function runLogoutCommand(options: LogoutCommandOptions = {}): Promise<number> {
  const home = options.home ?? getMemhubHome();
  const stored = readCredentials(home);
  if (stored === null) {
    console.log('Not logged in.');
    return 0;
  }
  const result = await remoteApiFetch(stored.url, stored.token, 'DELETE', '/api/auth/token');
  if (result.kind === 'unreachable') {
    console.error(`Cannot reach ${stored.url} — the credentials were kept.`);
    console.error(
      'Retry when the server is reachable, or delete ~/.memhub/credentials.json to forget the token.'
    );
    return 1;
  }
  if (result.status !== 200 && result.status !== 400 && result.status !== 401) {
    console.error(`Logout failed (HTTP ${result.status}).`);
    return 1;
  }
  deleteCredentials(home);
  // The configured default routes here too — leaving it behind would make
  // plain `memhub add` fail with "not logged in" after a logout.
  if (readConfig(home).base_url === stored.url) {
    unsetConfigValue(home, 'base-url');
    console.log(`Unset the default base-url (was ${stored.url}).`);
  }
  if (result.status === 401 || result.status === 400) {
    console.log(`Logged out from ${stored.url} (the stored token was already invalid there).`);
  } else {
    console.log(`Logged out from ${stored.url}.`);
  }
  return 0;
}

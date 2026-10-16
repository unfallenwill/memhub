/**
 * `memhub reset-password` command.
 *
 * Run ON THE SERVER that hosts the daemon data directory. Clears the
 * admin password (back to the uninitialized first-login state) and
 * revokes every device token. Refuses to run while the daemon is up:
 * the database must not be written by two processes at once.
 */

import { existsSync } from 'fs';
import { AdminPasswordStore } from '../daemon/admin-password.js';
import { DeviceTokenStore } from '../db/device-tokens.js';
import { openDatabase } from '../db/database.js';
import { getDefaultPort, getDatabasePath, getMemhubHome } from '../paths.js';
import { probeHealthz } from './client.js';

/** Options for the reset-password command. */
export interface ResetPasswordCommandOptions {
  /** Data directory override (tests). */
  readonly home?: string | undefined;
  /** Health probe override (tests). */
  readonly probe?: typeof probeHealthz | undefined;
  /** Port used by the local daemon. */
  readonly port?: number | undefined;
}

/** Run the reset-password command. Returns the process exit code. */
export async function runResetPasswordCommand(
  options: ResetPasswordCommandOptions = {}
): Promise<number> {
  const home = options.home ?? getMemhubHome();
  const dbPath = getDatabasePath(home);
  if (!existsSync(dbPath)) {
    console.error(`No MemHub database found at ${dbPath}.`);
    return 1;
  }

  const port = options.port ?? getDefaultPort();
  const probe = await (options.probe ?? probeHealthz)(port);
  if (probe.kind === 'memhub') {
    console.error('The MemHub daemon is running. Stop it first: memhub stop');
    return 1;
  }

  const db = openDatabase(dbPath);
  try {
    const adminAuth = new AdminPasswordStore(db);
    const wasInitialized = adminAuth.get() !== null;
    adminAuth.clear();
    const revoked = new DeviceTokenStore(db).revokeAll();
    if (!wasInitialized) {
      console.log('No admin password was set — nothing to reset.');
    } else {
      console.log('Admin password cleared. The next memhub login will set a new one.');
    }
    console.log(`Revoked ${revoked} device token${revoked === 1 ? '' : 's'}.`);
    return 0;
  } finally {
    db.close();
  }
}

/**
 * `memhub reset-password` command.
 *
 * Run ON THE SERVER that hosts the daemon data directory. Clears the
 * admin password (back to the uninitialized first-login state) and
 * revokes every device token. Refuses to run while the daemon is up:
 * the database must not be written by two processes at once.
 */

import { existsSync } from 'fs';
import { getDefaultPort, getDatabasePath, getMemhubHome } from '../../paths.js';
import { probeHealthz, type HealthProbe } from '../client.js';
import { parseFlags } from '../options.js';
import type { CommandImplementation } from '../types.js';

/** Options for the reset-password command. */
export interface ResetPasswordCommandOptions {
  /** Data directory override (tests). */
  readonly home?: string | undefined;
  /** Health probe override (tests). */
  readonly probe?: typeof probeHealthz | undefined;
  /** Port used by the local daemon. */
  readonly port?: number | undefined;
}

/** Parse `memhub reset-password` arguments. Throws on invalid input. */
export function parseResetPasswordArgs(argv: readonly string[]): ResetPasswordCommandOptions {
  const flags = parseFlags(argv, []);
  for (const entry of flags.entries) {
    throw new Error(`unknown option for reset-password: ${entry.arg}`);
  }
  return {};
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
  const probe: HealthProbe = await (options.probe ?? probeHealthz)(port);
  if (probe.kind === 'memhub') {
    console.error('The MemHub daemon is running. Stop it first: memhub stop');
    return 1;
  }

  // The database layer is loaded on demand: the CLI must not pull in
  // SQLite for the commands that only talk HTTP.
  const [{ openDatabase }, { AdminPasswordStore }, { DeviceTokenStore }] = await Promise.all([
    import('../../db/database.js'),
    import('../../db/admin-password.js'),
    import('../../db/device-tokens.js'),
  ]);
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

/** The reset-password command, as the registry sees it. */
export const resetPasswordCommand: CommandImplementation<ResetPasswordCommandOptions> = {
  parse: parseResetPasswordArgs,
  run: runResetPasswordCommand,
};

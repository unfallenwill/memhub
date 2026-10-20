/**
 * Path helpers.
 *
 * Pure path arithmetic on top of the resolved MemHub home directory. The
 * environment itself is read through ./env.js, never here.
 */

import { join } from 'path';
import { getMemhubHome } from './env.js';

/**
 * The legacy src/paths.ts surface (environment names and readers) is
 * re-exported here, so that the old entry point stays a single star
 * export while the implementation lives in the config layer.
 */
export {
  ALLOWED_HOSTS_ENV,
  BIND_HOST_ENV,
  DEFAULT_BIND_HOST,
  DEFAULT_PORT,
  MEMHUB_HOME_ENV,
  PORT_ENV,
  getAllowedHosts,
  getBindHost,
  getDefaultPort,
  getMemhubHome,
} from './env.js';

/** Path of the SQLite database inside a MemHub home directory. */
export function getDatabasePath(home: string = getMemhubHome()): string {
  return join(home, 'memhub.db');
}

/** Path of the API token file inside a MemHub home directory. */
export function getTokenPath(home: string = getMemhubHome()): string {
  return join(home, 'token');
}

/**
 * Path of the first-run setup code file. The code proves access to the
 * server's filesystem when the very first login sets the admin password;
 * without it anyone could claim a fresh remote deployment.
 */
export function getSetupCodePath(home: string = getMemhubHome()): string {
  return join(home, 'setup-code');
}

/** Path of the daemon log directory inside a MemHub home directory. */
export function getLogsDir(home: string = getMemhubHome()): string {
  return join(home, 'logs');
}

/** Path of the remote login credentials file (memhub login). */
export function getCredentialsPath(home: string = getMemhubHome()): string {
  return join(home, 'credentials.json');
}

/** Path of the CLI configuration file (memhub config). */
export function getConfigPath(home: string = getMemhubHome()): string {
  return join(home, 'config.json');
}

/** Path of the LanceDB vector store inside a MemHub home directory. */
export function getLanceDbPath(home: string = getMemhubHome()): string {
  return join(home, 'lancedb');
}

/** Path of the embedding model cache inside a MemHub home directory. */
export function getModelsDir(home: string = getMemhubHome()): string {
  return join(home, 'models');
}

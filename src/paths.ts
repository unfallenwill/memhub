/**
 * Data directory resolution.
 *
 * MemHub keeps a single global store under ~/.memhub by default.
 * The location can be overridden with the MEMHUB_HOME environment
 * variable (used by tests to point at temporary directories).
 */

import { homedir } from 'os';
import { join } from 'path';

/** Environment variable that overrides the data directory. */
export const MEMHUB_HOME_ENV = 'MEMHUB_HOME';

/** Default TCP port the daemon listens on (127.0.0.1 only). */
export const DEFAULT_PORT = 7800;

/** Resolve the MemHub data directory. */
export function getMemhubHome(): string {
  const override = process.env[MEMHUB_HOME_ENV];
  if (override && override.trim() !== '') {
    return override;
  }
  return join(homedir(), '.memhub');
}

/** Path of the SQLite database inside a MemHub home directory. */
export function getDatabasePath(home: string = getMemhubHome()): string {
  return join(home, 'memhub.db');
}

/** Path of the API token file inside a MemHub home directory. */
export function getTokenPath(home: string = getMemhubHome()): string {
  return join(home, 'token');
}

/** Path of the daemon log directory inside a MemHub home directory. */
export function getLogsDir(home: string = getMemhubHome()): string {
  return join(home, 'logs');
}

/** Path of the LanceDB vector store inside a MemHub home directory. */
export function getLanceDbPath(home: string = getMemhubHome()): string {
  return join(home, 'lancedb');
}

/** Path of the embedding model cache inside a MemHub home directory. */
export function getModelsDir(home: string = getMemhubHome()): string {
  return join(home, 'models');
}

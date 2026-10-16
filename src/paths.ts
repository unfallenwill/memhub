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

/** Environment variable overriding the HTTP bind address (cloud deployments). */
export const BIND_HOST_ENV = 'MEMHUB_HOST';

/** Environment variable overriding the default daemon port. */
export const PORT_ENV = 'MEMHUB_PORT';

/** Environment variable with extra allowed Host header values. */
export const ALLOWED_HOSTS_ENV = 'MEMHUB_ALLOWED_HOSTS';

/** Default TCP port the daemon listens on (127.0.0.1 only). */
export const DEFAULT_PORT = 7800;

/** Default bind address: loopback only (local threat model). */
export const DEFAULT_BIND_HOST = '127.0.0.1';

/** Resolve the MemHub data directory. */
export function getMemhubHome(): string {
  const override = process.env[MEMHUB_HOME_ENV];
  if (override && override.trim() !== '') {
    return override;
  }
  return join(homedir(), '.memhub');
}

/** Resolve the address the daemon binds (MEMHUB_HOST, default 127.0.0.1). */
export function getBindHost(): string {
  const value = process.env[BIND_HOST_ENV]?.trim();
  return value !== undefined && value !== '' ? value : DEFAULT_BIND_HOST;
}

/**
 * Resolve the default daemon port (MEMHUB_PORT, default 7800).
 * Throws on a malformed value so a config typo never silently binds 7800.
 */
export function getDefaultPort(): number {
  const raw = process.env[PORT_ENV]?.trim();
  if (raw === undefined || raw === '') return DEFAULT_PORT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`invalid ${PORT_ENV} value: ${raw}`);
  }
  return parsed;
}

/**
 * Parse MEMHUB_ALLOWED_HOSTS: comma-separated hostnames additionally
 * accepted in the Host header check (cloud deployments behind a proxy).
 * Values are lowercased and deduplicated; ports must be omitted (the
 * incoming Host header port is stripped before matching). A single "*"
 * accepts every Host header.
 */
export function getAllowedHosts(): string[] {
  const raw = process.env[ALLOWED_HOSTS_ENV];
  if (raw === undefined) return [];
  return [
    ...new Set(
      raw
        .split(',')
        .map(v => v.trim().toLowerCase())
        .filter(v => v !== '')
    ),
  ];
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

/** Path of the remote login credentials file (memhub login). */
export function getCredentialsPath(home: string = getMemhubHome()): string {
  return join(home, 'credentials.json');
}

/** Path of the LanceDB vector store inside a MemHub home directory. */
export function getLanceDbPath(home: string = getMemhubHome()): string {
  return join(home, 'lancedb');
}

/** Path of the embedding model cache inside a MemHub home directory. */
export function getModelsDir(home: string = getMemhubHome()): string {
  return join(home, 'models');
}

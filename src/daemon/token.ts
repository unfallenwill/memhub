/**
 * API token management.
 *
 * On first start a random token is generated and written to
 * ~/.memhub/token; later starts reuse it. The web UI (later milestone)
 * will receive the token via server-side injection; API clients must send
 * it as X-Memhub-Token.
 */

import { randomBytes } from 'crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'fs';

/** Environment variable with a fixed API token (cloud/container deployments). */
export const TOKEN_ENV = 'MEMHUB_TOKEN';

/**
 * Load the API token from <home>/token, creating it on first use.
 * The parent directory must already exist.
 */
export function loadOrCreateToken(tokenPath: string): string {
  if (existsSync(tokenPath)) {
    const existing = readFileSync(tokenPath, 'utf-8').trim();
    if (existing !== '') return existing;
  }
  const token = randomBytes(32).toString('hex');
  writeFileSync(tokenPath, token, { encoding: 'utf-8', mode: 0o600 });
  // writeFileSync only applies the mode when creating: re-assert it when
  // regenerating into a pre-existing (e.g. emptied) file with a loose mode.
  chmodSync(tokenPath, 0o600);
  return token;
}

/** Read the token, or null when it does not exist yet. */
export function readToken(tokenPath: string): string | null {
  if (!existsSync(tokenPath)) return null;
  const value = readFileSync(tokenPath, 'utf-8').trim();
  return value === '' ? null : value;
}

/**
 * Resolve the daemon token: MEMHUB_TOKEN wins over the token file.
 * Unlike the file path, the env token is never persisted.
 */
export function resolveToken(tokenPath: string): string {
  const fromEnv = process.env[TOKEN_ENV]?.trim();
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  return loadOrCreateToken(tokenPath);
}

/** Read the token without creating one: MEMHUB_TOKEN wins over the file. */
export function resolveExistingToken(tokenPath: string): string | null {
  const fromEnv = process.env[TOKEN_ENV]?.trim();
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  return readToken(tokenPath);
}

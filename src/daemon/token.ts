/**
 * API token management.
 *
 * On first start a random token is generated and written to
 * ~/.memhub/token; later starts reuse it. The web UI (later milestone)
 * will receive the token via server-side injection; API clients must send
 * it as X-Memhub-Token.
 */

import { randomBytes } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';

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
  return token;
}

/** Read the token, or null when it does not exist yet. */
export function readToken(tokenPath: string): string | null {
  if (!existsSync(tokenPath)) return null;
  const value = readFileSync(tokenPath, 'utf-8').trim();
  return value === '' ? null : value;
}

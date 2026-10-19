/**
 * Remote daemon credentials (written by `memhub login`).
 *
 * A single remote target is stored at <home>/credentials.json with
 * 0600 permissions (POSIX; Windows ignores the mode). Remote requests
 * always authenticate with this device token — MEMHUB_TOKEN is the
 * local daemon's token and is never sent to a remote daemon.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { getCredentialsPath, getMemhubHome } from '../paths.js';

/** Shape of the credentials file. */
export interface StoredCredentials {
  readonly version: 1;
  /** Normalized base URL, e.g. https://memhub.example.com. */
  readonly url: string;
  readonly token: string;
}

/**
 * Validate and normalize a base URL to its origin (http/https only).
 * Paths and trailing slashes are dropped — the user may paste
 * https://host/ or https://host/some/path and the origin is what the
 * API client needs.
 */
export function normalizeBaseUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  return url.origin;
}

/** Read stored credentials; null when absent or malformed. */
export function readCredentials(home: string = getMemhubHome()): StoredCredentials | null {
  const path = getCredentialsPath(home);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<StoredCredentials>;
    if (
      parsed.version === 1 &&
      typeof parsed.url === 'string' &&
      typeof parsed.token === 'string' &&
      parsed.url !== '' &&
      parsed.token !== ''
    ) {
      return { version: 1, url: parsed.url, token: parsed.token };
    }
  } catch {
    // fall through: unreadable credentials count as absent
  }
  return null;
}

/** Write credentials with restrictive permissions. */
export function writeCredentials(home: string, credentials: StoredCredentials): void {
  const path = getCredentialsPath(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(credentials, null, 2) + '\n', {
    encoding: 'utf-8',
    mode: 0o600,
  });
  // writeFileSync only applies the mode when creating: re-assert it so a
  // rewrite never leaves a previously loosened mode in place.
  chmodSync(path, 0o600);
}

/** Delete the credentials file; returns whether it existed. */
export function deleteCredentials(home: string = getMemhubHome()): boolean {
  const path = getCredentialsPath(home);
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}

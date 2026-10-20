/**
 * Admin password for the device-flow login (single administrator).
 *
 * The password is bootstrapped on the first `memhub login` (there is no
 * preset credential) and stored only as a scrypt hash in admin_auth.
 * Format: scrypt$N$r$p$<salt base64>$<hash base64>.
 *
 * Verification uses Node's built-in crypto.scrypt with an explicit
 * maxmem derived from the stored parameters (Node's 32MB default
 * rejects otherwise-valid large N).
 *
 * This module is the *domain* half of the admin password: hashing and
 * verification. The persistence half (the admin_auth table) is the
 * adapter in src/db/admin-password.ts.
 */

import { randomBytes, scrypt as scryptCb, scryptSync, timingSafeEqual } from 'crypto';
import { promisify } from 'util';

// The record type now lives in the pure domain layer; it is re-exported
// here so existing import points keep working.
export type { AdminAuthRecord } from '../core/domain/types.js';

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number }
) => Promise<Buffer>;

/** scrypt parameters used when hashing (OWASP-aligned cost). */
export const SCRYPT_PARAMS = { N: 32768, r: 8, p: 1 } as const;

/** Salt and output lengths in bytes. */
const SALT_BYTES = 16;
const KEY_BYTES = 32;

/** Parsed scrypt hash parameters. */
interface ScryptParams {
  readonly N: number;
  readonly r: number;
  readonly p: number;
  readonly salt: Buffer;
  readonly hash: Buffer;
}

/** Hash a password into the persisted scrypt$... format. */
export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(password, salt, KEY_BYTES, {
    ...SCRYPT_PARAMS,
    maxmem: 128 * SCRYPT_PARAMS.N * SCRYPT_PARAMS.r + 64 * 1024 * 1024,
  });
  return [
    'scrypt',
    SCRYPT_PARAMS.N,
    SCRYPT_PARAMS.r,
    SCRYPT_PARAMS.p,
    salt.toString('base64'),
    hash.toString('base64'),
  ].join('$');
}

/**
 * Parse and validate a stored scrypt hash. Throws on anything malformed
 * (wrong segment count, non-power-of-two N, absurd memory demands).
 */
export function parseScryptHash(stored: string): ScryptParams {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    throw new Error('malformed password hash: expected scrypt$N$r$p$salt$hash');
  }
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) {
    throw new Error('malformed password hash: non-integer scrypt parameters');
  }
  if (N < 2 || N > 2 ** 22 || (N & (N - 1)) !== 0) {
    throw new Error(`malformed password hash: invalid N=${parts[1]}`);
  }
  if (r < 1 || r > 32 || p < 1 || p > 10) {
    throw new Error('malformed password hash: invalid r/p parameters');
  }
  if (128 * N * r > 256 * 1024 * 1024) {
    throw new Error('malformed password hash: parameterization exceeds 256MB');
  }
  const salt = Buffer.from(parts[4], 'base64');
  const hash = Buffer.from(parts[5], 'base64');
  if (salt.length === 0 || hash.length === 0) {
    throw new Error('malformed password hash: empty salt or hash');
  }
  return { N, r, p, salt, hash };
}

/** Verify a candidate password against a stored hash (timing-safe). */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const params = parseScryptHash(stored);
  const derived = await scrypt(password, params.salt, params.hash.length, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: 128 * params.N * params.r + 64 * 1024 * 1024,
  });
  return derived.length === params.hash.length && timingSafeEqual(derived, params.hash);
}

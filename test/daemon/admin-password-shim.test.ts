/**
 * The legacy import path of the admin password.
 *
 * `memhub/dist/src/daemon/admin-password.js` shipped in v1 and is a
 * deep-import path consumers may use. The implementation moved to
 * src/auth/ (the hashing) and src/db/ (the persistence), so this
 * module is a re-export shim. These tests pin the shim down: the path
 * keeps working and keeps exporting the same names.
 */

import { describe, expect, it } from 'vitest';
import {
  SCRYPT_PARAMS,
  hashPassword,
  parseScryptHash,
  verifyPassword,
} from '../../src/daemon/admin-password.js';

describe('the admin password shim', () => {
  it('re-exports the hashing helpers of the auth layer', async () => {
    const stored = hashPassword('correct horse');
    expect(stored.startsWith('scrypt$')).toBe(true);
    expect(SCRYPT_PARAMS.N).toBe(32768);
    expect(await verifyPassword('correct horse', stored)).toBe(true);
    expect(await verifyPassword('wrong', stored)).toBe(false);
  });

  it('re-exports the hash parser', () => {
    const params = parseScryptHash(hashPassword('x'));
    expect(params.N).toBe(SCRYPT_PARAMS.N);
    expect(params.hash.length).toBe(32);
  });
});

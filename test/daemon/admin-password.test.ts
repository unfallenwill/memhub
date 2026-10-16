import { afterEach, describe, expect, it } from 'vitest';
import {
  AdminPasswordStore,
  hashPassword,
  verifyPassword,
} from '../../src/daemon/admin-password.js';
import { createTestDb, type TestDb } from '../test-utils.js';

describe('admin password', () => {
  let t: TestDb;
  afterEach(() => {
    t?.close();
  });

  describe('hashPassword / verifyPassword', () => {
    it('round-trips a password', async () => {
      const stored = hashPassword('correct horse battery staple');
      expect(stored.startsWith('scrypt$32768$8$1$')).toBe(true);
      await expect(verifyPassword('correct horse battery staple', stored)).resolves.toBe(true);
    });

    it('rejects a wrong password', async () => {
      const stored = hashPassword('correct horse battery staple');
      await expect(verifyPassword('wrong password', stored)).resolves.toBe(false);
    });

    it('produces different salts for the same password', () => {
      expect(hashPassword('same')).not.toBe(hashPassword('same'));
    });
  });

  describe('malformed stored hashes', () => {
    it('rejects wrong segment counts and prefixes', async () => {
      for (const bad of ['', 'plaintext', 'scrypt$1$2', 'bcrypt$1$2$3$4$5']) {
        await expect(verifyPassword('pw', bad)).rejects.toThrow(/malformed/);
      }
    });

    it('rejects non-power-of-two N and absurd parameters', async () => {
      const parts = hashPassword('pw').split('$');
      parts[1] = '1000'; // not a power of two
      await expect(verifyPassword('pw', parts.join('$'))).rejects.toThrow(/N/);
      parts[1] = '4194304'; // 4M * 128 * 8 > 256MB cap
      await expect(verifyPassword('pw', parts.join('$'))).rejects.toThrow(/256MB/);
      parts[1] = '32768';
      parts[2] = '99'; // r out of range
      await expect(verifyPassword('pw', parts.join('$'))).rejects.toThrow(/r\/p/);
    });
  });

  describe('AdminPasswordStore', () => {
    it('starts uninitialized, set then clear', () => {
      t = createTestDb();
      const store = new AdminPasswordStore(t.db);
      expect(store.get()).toBeNull();
      const hash = hashPassword('initial-password');
      store.set(hash);
      expect(store.get()?.passwordHash).toBe(hash);
      store.set(hashPassword('rotated'));
      expect(store.get()?.passwordHash).not.toBe(hash);
      store.clear();
      expect(store.get()).toBeNull();
    });

    it('migration v2 created the tables', () => {
      t = createTestDb();
      const version = t.db.prepare('PRAGMA user_version').get() as { user_version: number };
      expect(version.user_version).toBe(2);
      const tables = t.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('admin_auth','device_tokens')"
        )
        .all() as { name: string }[];
      expect(tables.map(row => row.name).sort()).toEqual(['admin_auth', 'device_tokens']);
    });
  });
});

/**
 * The commands that fall back to the environment for their data
 * directory (src/cli/commands/*).
 *
 * `config`, `search` and `reset-password` read the home directory from
 * the environment when the caller does not pass one. The fallback must
 * never reach the real ~/.memhub: the tests point MEMHUB_HOME at a
 * throwaway directory.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configCommand, runConfigCommand } from '../../../src/cli/commands/config.js';
import { runResetPasswordCommand } from '../../../src/cli/commands/reset-password.js';
import { runSearchCommand } from '../../../src/cli/commands/search.js';
import { hashPassword } from '../../../src/auth/admin-password.js';
import { AdminPasswordStore } from '../../../src/db/admin-password.js';
import { DeviceTokenStore, tokenHash } from '../../../src/db/device-tokens.js';
import { openDatabase } from '../../../src/db/database.js';
import { getDatabasePath } from '../../../src/config/paths.js';

describe('the home directory fallback of the CLI commands', () => {
  const dirs: string[] = [];
  let home: string;
  let logs: string[];
  let errors: string[];

  function tempHome(): string {
    const dir = mkdtempSync(join(tmpdir(), 'memhub-home-fallback-'));
    dirs.push(dir);
    return dir;
  }

  beforeEach(() => {
    home = tempHome();
    logs = [];
    errors = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.join(' '));
    });
    vi.stubEnv('MEMHUB_HOME', home);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  describe('memhub config', () => {
    it('reads the config of the home directory from the environment', () => {
      writeFileSync(
        join(home, 'config.json'),
        JSON.stringify({ version: 1, base_url: 'https://x.example' })
      );

      expect(runConfigCommand({ action: 'list' })).toBe(0);
      expect(logs.join('\n')).toContain('base-url=https://x.example');
    });

    it('runs through the registry command implementation', async () => {
      writeFileSync(
        join(home, 'config.json'),
        JSON.stringify({ version: 1, base_url: 'https://x.example' })
      );

      const code = await configCommand.run({ action: 'list' });

      expect(code).toBe(0);
      expect(logs.join('\n')).toContain('base-url=https://x.example');
    });
  });

  describe('memhub search', () => {
    it('resolves the data directory from the environment', async () => {
      const code = await runSearchCommand({
        query: 'anything',
        mode: 'auto',
        limit: 10,
        port: 7800,
      });

      // No token file in the fallback home: the target is invalid and the
      // command reports it instead of writing anywhere.
      expect(code).toBe(1);
      expect(errors.join('\n')).toContain('No MemHub token found');
    });
  });

  describe('memhub reset-password', () => {
    it('resolves the data directory and the health probe from the environment', async () => {
      const db = openDatabase(getDatabasePath(home));
      new AdminPasswordStore(db).set(hashPassword('password-1'));
      new DeviceTokenStore(db).create(tokenHash('a'.repeat(64)), 'user@host');
      db.close();

      // The real probe is used; a refused connection means "not running".
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error('ECONNREFUSED');
        })
      );

      const code = await runResetPasswordCommand({ port: 1 });

      expect(code).toBe(0);
      expect(logs.join('\n')).toContain('Admin password cleared');
      expect(logs.join('\n')).toContain('Revoked 1 device token.');
    });
  });
});

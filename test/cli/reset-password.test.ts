import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runResetPasswordCommand } from '../../src/cli/reset-password.js';
import { AdminPasswordStore, hashPassword } from '../../src/daemon/admin-password.js';
import { DeviceTokenStore, tokenHash } from '../../src/db/device-tokens.js';
import { openDatabase } from '../../src/db/database.js';
import { getDatabasePath } from '../../src/paths.js';
import type { HealthProbe } from '../../src/cli/client.js';

describe('runResetPasswordCommand', () => {
  const dirs: string[] = [];
  let home: string;
  let logs: string[];
  let errors: string[];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'memhub-reset-'));
    dirs.push(home);
    logs = [];
    errors = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => logs.push(args.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) =>
      errors.push(args.join(' '))
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  function seed(): void {
    const db = openDatabase(getDatabasePath(home));
    new AdminPasswordStore(db).set(hashPassword('password-1'));
    new DeviceTokenStore(db).create(tokenHash('a'.repeat(64)), 'user@host');
    new DeviceTokenStore(db).create(tokenHash('b'.repeat(64)), 'other@host');
    db.close();
  }

  it('refuses when no database exists', async () => {
    expect(await runResetPasswordCommand({ home })).toBe(1);
    expect(errors.join('\n')).toContain('No MemHub database');
  });

  it('refuses while the daemon is running', async () => {
    seed();
    const probe = vi.fn(async (): Promise<HealthProbe> => ({ kind: 'memhub' }));
    const code = await runResetPasswordCommand({ home, probe });
    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('memhub stop');
    // Nothing was cleared.
    const db = openDatabase(getDatabasePath(home));
    expect(new AdminPasswordStore(db).get()).not.toBeNull();
    db.close();
  });

  it('clears the password and revokes all tokens when stopped', async () => {
    seed();
    const probe = vi.fn(async (): Promise<HealthProbe> => ({ kind: 'unreachable' }));
    const code = await runResetPasswordCommand({ home, probe });
    expect(code).toBe(0);
    expect(logs.join('\n')).toContain('Admin password cleared');
    expect(logs.join('\n')).toContain('Revoked 2 device tokens');
    const db = openDatabase(getDatabasePath(home));
    expect(new AdminPasswordStore(db).get()).toBeNull();
    expect(new DeviceTokenStore(db).list().every(d => d.revokedAt !== null)).toBe(true);
    db.close();
  });

  it('reports nothing-to-reset when never initialized', async () => {
    openDatabase(getDatabasePath(home)).close();
    const probe = vi.fn(async (): Promise<HealthProbe> => ({ kind: 'unreachable' }));
    const code = await runResetPasswordCommand({ home, probe });
    expect(code).toBe(0);
    expect(logs.join('\n')).toContain('nothing to reset');
  });
});

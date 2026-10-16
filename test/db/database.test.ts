import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase, withTransaction } from '../../src/db/database.js';
import { getSchemaVersion, migrateDatabase, MIGRATIONS } from '../../src/db/migrations.js';

describe('database', () => {
  const dirs: string[] = [];
  const dbs: DatabaseSync[] = [];

  function tempDb(): DatabaseSync {
    const dir = mkdtempSync(join(tmpdir(), 'memhub-db-'));
    dirs.push(dir);
    const db = openDatabase(join(dir, 'memhub.db'));
    dbs.push(db);
    return db;
  }

  afterEach(() => {
    for (const db of dbs.splice(0)) {
      db.close();
    }
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it('enables WAL mode and busy_timeout', () => {
    const db = tempDb();
    const journal = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    const busy = db.prepare('PRAGMA busy_timeout').get() as { timeout: number };
    expect(journal.journal_mode.toLowerCase()).toBe('wal');
    expect(busy.timeout).toBe(5000);
  });

  it('applies migrations and records them', () => {
    const db = tempDb();
    expect(getSchemaVersion(db)).toBe(MIGRATIONS[MIGRATIONS.length - 1].version);
    const rows = db
      .prepare('SELECT version, name FROM schema_migrations ORDER BY version')
      .all() as unknown as { version: number; name: string }[];
    expect(rows.map(row => row.name)).toEqual(MIGRATIONS.map(m => m.name));
  });

  it('is idempotent when migrations run again', () => {
    const db = tempDb();
    expect(() => migrateDatabase(db)).not.toThrow();
    expect(getSchemaVersion(db)).toBe(MIGRATIONS[MIGRATIONS.length - 1].version);
    const rows = db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number };
    expect(rows.n).toBe(MIGRATIONS.length);
  });

  it('creates all core tables', () => {
    const db = tempDb();
    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','trigger')")
        .all() as unknown as { name: string }[]
    ).map(row => row.name);
    for (const expected of [
      'cards',
      'cards_fts',
      'events',
      'worker_state',
      'activity_log',
      'schema_migrations',
      'cards_fts_insert',
      'cards_fts_delete',
      'cards_fts_update',
    ]) {
      expect(tables).toContain(expected);
    }
  });

  it('withTransaction commits on success and rolls back on error', () => {
    const db = tempDb();
    withTransaction(db, () => {
      db.prepare('INSERT INTO worker_state(key, value) VALUES (?, ?)').run('a', '1');
    });
    expect(
      (db.prepare("SELECT value FROM worker_state WHERE key = 'a'").get() as { value: string })
        .value
    ).toBe('1');

    expect(() =>
      withTransaction(db, () => {
        db.prepare('INSERT INTO worker_state(key, value) VALUES (?, ?)').run('b', '2');
        throw new Error('boom');
      })
    ).toThrow('boom');
    const after = db.prepare("SELECT COUNT(*) AS n FROM worker_state WHERE key = 'b'").get() as {
      n: number;
    };
    expect(after.n).toBe(0);
  });
});

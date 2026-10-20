/**
 * A migration that fails (src/db/migrations.ts).
 *
 * The migrations run inside a transaction: when a statement fails the
 * whole migration is rolled back, the version is not advanced and the
 * error is reported to the caller.
 */

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { getSchemaVersion, migrateDatabase } from '../../src/db/migrations.js';

const homes: string[] = [];

/** A throwaway home directory with a database file in it. */
function tempDbPath(): string {
  const home = mkdtempSync(join(tmpdir(), 'memhub-migrations-'));
  homes.push(home);
  return join(home, 'memhub.db');
}

/** The names of the tables a database holds. */
function tableNames(db: DatabaseSync): string[] {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
    name: string;
  }[];
  return rows.map(row => row.name);
}

afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

describe('a migration that cannot be applied', () => {
  it('rolls the migration back and reports the failure', () => {
    const path = tempDbPath();
    const db = new DatabaseSync(path);
    try {
      // A table that collides with a statement of the first migration.
      db.exec('CREATE TABLE events(id INTEGER)');

      expect(() => migrateDatabase(db)).toThrow(/already exists/);

      // The statements that ran before the failing one were rolled back.
      expect(tableNames(db)).not.toContain('cards');
      // The schema version was not advanced.
      expect(getSchemaVersion(db)).toBe(0);
    } finally {
      db.close();
    }
  });

  it('leaves the database ready for a retry once the collision is gone', () => {
    const path = tempDbPath();
    const db = new DatabaseSync(path);
    try {
      db.exec('CREATE TABLE events(id INTEGER)');
      expect(() => migrateDatabase(db)).toThrow();

      db.exec('DROP TABLE events');
      migrateDatabase(db);

      expect(tableNames(db)).toContain('cards');
      expect(getSchemaVersion(db)).toBe(2);
    } finally {
      db.close();
    }
  });
});

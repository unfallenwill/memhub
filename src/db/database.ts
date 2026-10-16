/**
 * Database bootstrap.
 *
 * Opens ~/.memhub/memhub.db with node:sqlite, enables WAL + busy_timeout
 * for safe concurrent access from the HTTP handler and (later) the worker,
 * and applies pending schema migrations.
 */

import { DatabaseSync } from 'node:sqlite';
import { migrateDatabase } from './migrations.js';

/** SQLite busy timeout in milliseconds. */
export const BUSY_TIMEOUT_MS = 5000;

/**
 * Open (and migrate) the MemHub database.
 * The parent directory must already exist.
 */
export function openDatabase(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode = WAL`);
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.exec(`PRAGMA foreign_keys = ON`);
  migrateDatabase(db);
  return db;
}

/**
 * Run a function inside a single write transaction.
 * ROLLBACK on throw, COMMIT on success.
 */
export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

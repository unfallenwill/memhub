/**
 * Database bootstrap and transaction handling.
 *
 * Opens ~/.memhub/memhub.db with node:sqlite, enables WAL + busy_timeout
 * for safe concurrent access from the HTTP handler and (later) the worker,
 * and applies pending schema migrations.
 *
 * The write path must stay constant-fast: one transaction covers the card
 * insert plus its event and activity-log rows. The transaction boundary is
 * expressed through the `TransactionRunner` port so the persistence layer
 * stays free of any domain knowledge.
 */

import { DatabaseSync } from 'node:sqlite';
import type { TransactionRunner } from '../core/ports/transaction.js';
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

/** Thrown when a transaction is started while another one is still open. */
export class NestedTransactionError extends Error {
  constructor() {
    super(
      'nested transaction rejected: a transaction is already open on this database; ' +
        'transactions must not be nested'
    );
    this.name = 'NestedTransactionError';
  }
}

/**
 * SQLite implementation of the `TransactionRunner` port.
 *
 * COMMIT on success, ROLLBACK + rethrow on error. Nesting is rejected
 * with a `NestedTransactionError` instead of being silently flattened or
 * joined: a nested transaction would either commit the outer work early
 * or roll it back, and both are silent data corruption.
 */
export class SqliteTransactionRunner implements TransactionRunner {
  /** 1 while a transaction is open, 0 otherwise. */
  private depth = 0;

  constructor(private readonly db: DatabaseSync) {}

  /** Run a function inside a single write transaction. */
  transaction<T>(fn: () => T): T {
    if (this.depth > 0) {
      throw new NestedTransactionError();
    }
    this.depth = 1;
    try {
      this.db.exec('BEGIN IMMEDIATE');
    } catch (error) {
      // BEGIN failed (e.g. the connection is already inside a
      // transaction): there is nothing of ours to roll back.
      this.depth = 0;
      throw error;
    }
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      // Always reset the depth, so a failed transaction never leaves the
      // runner in a state where every later transaction is rejected.
      this.depth = 0;
    }
  }
}

/**
 * One runner per open database.
 *
 * Sharing the runner per connection is what makes the nesting check
 * meaningful: the free `withTransaction` helper and the stores that were
 * handed the same runner all see the same transaction depth.
 *
 * SCOPE: the guard covers ONE connection. A second handle on the same
 * file has its own runner and its own depth counter, so the two do not
 * see each other's transactions - SQLite's own write lock (and the busy
 * timeout) is what keeps them apart. `memhub reindex` therefore must not
 * run while the daemon holds the database.
 */
const runners = new WeakMap<DatabaseSync, SqliteTransactionRunner>();

/** The transaction runner bound to a database connection. */
export function getTransactionRunner(db: DatabaseSync): SqliteTransactionRunner {
  const existing = runners.get(db);
  if (existing !== undefined) return existing;
  const runner = new SqliteTransactionRunner(db);
  runners.set(db, runner);
  return runner;
}

/**
 * Run a function inside a single write transaction.
 * ROLLBACK on throw, COMMIT on success.
 *
 * Kept for backwards compatibility only: the production code injects a
 * `TransactionRunner` (see src/core/ports/transaction.ts) instead of
 * reaching for the database handle. New code should take the runner as
 * a dependency.
 */
export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  return getTransactionRunner(db).transaction(fn);
}

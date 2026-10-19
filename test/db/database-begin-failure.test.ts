/**
 * The transaction runner of the SQLite adapter (src/db/database.ts).
 *
 * The runner is the single place that knows about BEGIN/COMMIT/ROLLBACK.
 * Two failure modes matter: a BEGIN that cannot be started (the
 * connection is already inside a transaction) and the guarantee that a
 * failed transaction never leaves the runner in a state where every
 * later transaction is rejected.
 */

import { describe, expect, it } from 'vitest';
import {
  getTransactionRunner,
  NestedTransactionError,
  withTransaction,
} from '../../src/db/database.js';
import { createTestDb } from '../test-utils.js';

describe('SqliteTransactionRunner', () => {
  it('commits on success and rolls back on failure', () => {
    const t = createTestDb();
    try {
      t.db.exec('CREATE TABLE probe (value TEXT)');
      withTransaction(t.db, () => {
        t.db.exec("INSERT INTO probe (value) VALUES ('a')");
      });
      expect(t.db.prepare('SELECT COUNT(*) AS n FROM probe').get()).toEqual({ n: 1 });

      expect(() =>
        withTransaction(t.db, () => {
          t.db.exec("INSERT INTO probe (value) VALUES ('b')");
          throw new Error('boom');
        })
      ).toThrow('boom');
      expect(t.db.prepare('SELECT COUNT(*) AS n FROM probe').get()).toEqual({ n: 1 });
    } finally {
      t.close();
    }
  });

  it('rejects a nested transaction', () => {
    const t = createTestDb();
    try {
      const runner = getTransactionRunner(t.db);
      expect(() =>
        runner.transaction(() => {
          runner.transaction(() => undefined);
        })
      ).toThrow(NestedTransactionError);
    } finally {
      t.close();
    }
  });

  it('resets its depth when the BEGIN itself fails', () => {
    const t = createTestDb();
    try {
      const runner = getTransactionRunner(t.db);
      // A transaction that is already open on the connection makes the
      // BEGIN of the runner fail: there is nothing of ours to roll back.
      t.db.exec('BEGIN');
      expect(() => runner.transaction(() => undefined)).toThrow();

      // The runner must not stay "in a transaction" after the failure.
      t.db.exec('ROLLBACK');
      expect(runner.transaction(() => 42)).toBe(42);
    } finally {
      t.close();
    }
  });

  it('returns the same runner for the same database', () => {
    const t = createTestDb();
    try {
      expect(getTransactionRunner(t.db)).toBe(getTransactionRunner(t.db));
    } finally {
      t.close();
    }
  });
});

/**
 * The scope of the transaction guard.
 *
 * The nesting check is bound to ONE connection: a second handle on the
 * same file has its own runner and its own depth counter, so the two
 * do not see each other's transactions. SQLite's own write lock (and
 * the busy timeout) is what keeps them apart - which is why
 * `memhub reindex` must not run while the daemon holds the database.
 *
 * The error of a rejected nested transaction is a MemHub error, not a
 * SQLite one: the name is part of the contract, because the HTTP layer
 * maps it to a 500 and a log rule may match on it.
 */

import { DatabaseSync } from 'node:sqlite';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { NestedTransactionError, withTransaction } from '../../src/db/database.js';
import { cardInput, createTestDb, type TestDb } from '../test-utils.js';

/** Count the rows of a table. */
function count(t: TestDb, table: string): number {
  const row = t.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

describe('the scope of the nesting guard', () => {
  let t: TestDb;
  let second: DatabaseSync | undefined;

  afterEach(() => {
    second?.close();
    second = undefined;
    t.close();
  });

  it('does not see the transaction of a second handle on the same file', () => {
    t = createTestDb();
    // A second connection to the same file, with a short busy timeout so
    // the test does not wait for the default one.
    second = new DatabaseSync(join(t.home, 'memhub.db'));
    second.exec('PRAGMA busy_timeout = 50');

    const error = (() => {
      try {
        withTransaction(t.db, () => {
          t.db.prepare('INSERT INTO worker_state(key, value) VALUES (?, ?)').run('a', '1');
          withTransaction(second as DatabaseSync, () => {
            (second as DatabaseSync)
              .prepare('INSERT INTO worker_state(key, value) VALUES (?, ?)')
              .run('b', '2');
          });
        });
        return undefined;
      } catch (thrown) {
        return thrown as { errcode?: number; errstr?: string; message?: string };
      }
    })();

    // The write lock of the first handle is what stops the second one -
    // not the nesting guard, which only knows its own connection.
    expect(error).toBeDefined();
    expect(error).not.toBeInstanceOf(NestedTransactionError);
    expect(error?.errcode).toBe(5); // SQLITE_BUSY
    expect(error?.errstr).toBe('database is locked');
    // The outer transaction was rolled back with the failed attempt.
    expect(count(t, 'worker_state')).toBe(0);
  });

  it('lets the second handle write once the first one committed', () => {
    t = createTestDb();
    second = new DatabaseSync(join(t.home, 'memhub.db'));
    second.exec('PRAGMA busy_timeout = 50');

    withTransaction(t.db, () => {
      t.db.prepare('INSERT INTO worker_state(key, value) VALUES (?, ?)').run('a', '1');
    });

    expect(() =>
      withTransaction(second as DatabaseSync, () => {
        (second as DatabaseSync)
          .prepare('INSERT INTO worker_state(key, value) VALUES (?, ?)')
          .run('b', '2');
      })
    ).not.toThrow();
  });
});

describe('the error of a rejected nested transaction', () => {
  let t: TestDb;

  afterEach(() => {
    t.close();
  });

  it('is a NestedTransactionError and rolls the outer transaction back', () => {
    t = createTestDb();

    const error = (() => {
      try {
        withTransaction(t.db, () => {
          t.db.prepare('INSERT INTO worker_state(key, value) VALUES (?, ?)').run('a', '1');
          withTransaction(t.db, () => {
            t.db.prepare('INSERT INTO worker_state(key, value) VALUES (?, ?)').run('b', '2');
          });
        });
        return undefined;
      } catch (thrown) {
        return thrown as Error;
      }
    })();

    expect(error).toBeInstanceOf(NestedTransactionError);
    expect(error?.name).toBe('NestedTransactionError');
    expect(error?.message).toMatch(/nested transaction/i);
    // Nothing of the outer transaction survived the rejection.
    expect(count(t, 'worker_state')).toBe(0);
  });

  it('rolls a card write back when it is nested into another transaction', () => {
    t = createTestDb();

    expect(() =>
      withTransaction(t.db, () => {
        t.cards.createCard(cardInput({ title: 'T', body: 'B' }));
      })
    ).toThrow(NestedTransactionError);

    expect(count(t, 'cards')).toBe(0);
    expect(count(t, 'events')).toBe(0);
    expect(count(t, 'activity_log')).toBe(0);
  });
});

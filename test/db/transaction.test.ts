/**
 * The transaction runner is the boundary of the write path.
 *
 * It commits on success, rolls back and rethrows on failure, and refuses
 * to nest: a nested transaction would commit the outer work early or roll
 * it back, and both are silent data corruption.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  getTransactionRunner,
  NestedTransactionError,
  SqliteTransactionRunner,
  withTransaction,
} from '../../src/db/database.js';
import { cardInput, createTestDb, type TestDb } from '../test-utils.js';

/** Count the rows of a table. */
function count(t: TestDb, table: string): number {
  const row = t.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

describe('SqliteTransactionRunner', () => {
  let t: TestDb;

  afterEach(() => {
    t.close();
  });

  it('commits the work of a successful transaction', () => {
    t = createTestDb();
    const runner = new SqliteTransactionRunner(t.db);

    const result = runner.transaction(() => {
      t.db
        .prepare(
          `INSERT INTO cards(title, body, type, cues, confidence, status, created_at, updated_at)
           VALUES ('T', 'B', 'fact', '[]', 0.5, 'active', '2024-01-01', '2024-01-01')`
        )
        .run();
      return 'done';
    });

    expect(result).toBe('done');
    expect(count(t, 'cards')).toBe(1);
  });

  it('rolls back and rethrows the original error', () => {
    t = createTestDb();
    const runner = new SqliteTransactionRunner(t.db);

    expect(() =>
      runner.transaction(() => {
        t.db
          .prepare(
            `INSERT INTO cards(title, body, type, cues, confidence, status, created_at, updated_at)
             VALUES ('T', 'B', 'fact', '[]', 0.5, 'active', '2024-01-01', '2024-01-01')`
          )
          .run();
        throw new Error('boom');
      })
    ).toThrow('boom');

    expect(count(t, 'cards')).toBe(0);
  });

  it('rejects a nested transaction with a clear error', () => {
    t = createTestDb();
    const runner = new SqliteTransactionRunner(t.db);

    const error = (() => {
      try {
        runner.transaction(() => {
          runner.transaction(() => {
            t.db.prepare('INSERT INTO worker_state(key, value) VALUES (?, ?)').run('a', '1');
          });
        });
      } catch (thrown) {
        return thrown;
      }
      return undefined;
    })();

    expect(error).toBeInstanceOf(NestedTransactionError);
    expect((error as Error).message).toMatch(/nested transaction/i);
    // The nested attempt must not have written anything.
    expect(count(t, 'worker_state')).toBe(0);
  });

  it('resets its depth after a rejected nested transaction', () => {
    t = createTestDb();
    const runner = new SqliteTransactionRunner(t.db);

    expect(() =>
      runner.transaction(() => {
        runner.transaction(() => undefined);
      })
    ).toThrow(NestedTransactionError);

    // The runner is usable again: the failed attempt left no depth behind.
    runner.transaction(() => {
      t.db.prepare('INSERT INTO worker_state(key, value) VALUES (?, ?)').run('a', '1');
    });
    expect(count(t, 'worker_state')).toBe(1);
  });

  it('can still commit the outer transaction when the nested error is caught', () => {
    t = createTestDb();
    const runner = new SqliteTransactionRunner(t.db);

    runner.transaction(() => {
      t.db.prepare('INSERT INTO worker_state(key, value) VALUES (?, ?)').run('a', '1');
      try {
        runner.transaction(() => undefined);
      } catch (error) {
        expect(error).toBeInstanceOf(NestedTransactionError);
      }
    });

    expect(count(t, 'worker_state')).toBe(1);
  });

  it('resets its depth after a failed transaction', () => {
    t = createTestDb();
    const runner = new SqliteTransactionRunner(t.db);

    expect(() =>
      runner.transaction(() => {
        throw new Error('boom');
      })
    ).toThrow('boom');

    runner.transaction(() => {
      t.db.prepare('INSERT INTO worker_state(key, value) VALUES (?, ?)').run('a', '1');
    });
    expect(count(t, 'worker_state')).toBe(1);
  });
});

describe('withTransaction', () => {
  let t: TestDb;

  afterEach(() => {
    t.close();
  });

  it('commits on success and rolls back on error', () => {
    t = createTestDb();

    withTransaction(t.db, () => {
      t.db.prepare('INSERT INTO worker_state(key, value) VALUES (?, ?)').run('a', '1');
    });
    expect(count(t, 'worker_state')).toBe(1);

    expect(() =>
      withTransaction(t.db, () => {
        t.db.prepare('INSERT INTO worker_state(key, value) VALUES (?, ?)').run('b', '2');
        throw new Error('boom');
      })
    ).toThrow('boom');
    expect(count(t, 'worker_state')).toBe(1);
  });

  it('rejects a nested transaction', () => {
    t = createTestDb();

    expect(() =>
      withTransaction(t.db, () => {
        withTransaction(t.db, () => {
          t.db.prepare('INSERT INTO worker_state(key, value) VALUES (?, ?)').run('a', '1');
        });
      })
    ).toThrow(NestedTransactionError);

    expect(count(t, 'worker_state')).toBe(0);
  });

  it('shares one runner per database connection', () => {
    t = createTestDb();
    expect(getTransactionRunner(t.db)).toBe(getTransactionRunner(t.db));
  });
});

describe('the card store writes through the runner', () => {
  let t: TestDb;

  afterEach(() => {
    t.close();
  });

  it('rolls the whole write back when a part of it fails', () => {
    t = createTestDb();
    t.db.exec(
      `CREATE TRIGGER test_fail_activity BEFORE INSERT ON activity_log
       BEGIN SELECT RAISE(ABORT, 'injected failure'); END;`
    );

    expect(() => t.cards.createCard(cardInput({ title: 'T', body: 'B' }))).toThrow(
      /injected failure/
    );

    expect(count(t, 'cards')).toBe(0);
    expect(count(t, 'events')).toBe(0);
    expect(count(t, 'activity_log')).toBe(0);
  });

  it('rejects a card write nested inside another transaction', () => {
    t = createTestDb();

    expect(() =>
      withTransaction(t.db, () => {
        t.cards.createCard(cardInput({ title: 'T', body: 'B' }));
      })
    ).toThrow(NestedTransactionError);

    expect(count(t, 'cards')).toBe(0);
  });
});

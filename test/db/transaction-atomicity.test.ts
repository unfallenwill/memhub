/**
 * Characterization test: the write path is atomic.
 *
 * A card write touches three tables (cards, events, activity_log) inside
 * one transaction. When any of them fails, none of them may keep a row:
 * a card without its event would never be indexed, a card without its
 * audit entry would be invisible to the activity feed.
 *
 * The failure is injected with SQLite triggers (RAISE(ABORT)) so the real
 * store classes are exercised - no fakes, no monkey patching.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withTransaction } from '../../src/db/database.js';
import { cardInput, createTestDb, type TestDb } from '../test-utils.js';

/** Count the rows of a table. */
function count(t: TestDb, table: string): number {
  const row = t.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

/** Number of rows in the FTS mirror of the cards table. */
function ftsCount(t: TestDb): number {
  const row = t.db.prepare('SELECT COUNT(*) AS n FROM cards_fts').get() as { n: number };
  return row.n;
}

/** Make every INSERT into the given table fail. */
function breakInserts(t: TestDb, table: string): void {
  t.db.exec(
    `CREATE TRIGGER test_fail_${table} BEFORE INSERT ON ${table}
     BEGIN SELECT RAISE(ABORT, 'injected ${table} failure'); END;`
  );
}

/** Capture the error thrown by a failing call. */
function captureError(fn: () => unknown): Error {
  try {
    fn();
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error('expected the call to throw');
}

describe('write path atomicity', () => {
  let t: TestDb;

  beforeEach(() => {
    t = createTestDb();
  });

  afterEach(() => {
    t.close();
  });

  describe('createCard', () => {
    it('writes exactly one row into cards, events and activity_log', () => {
      const result = t.cards.createCard(cardInput({ title: 'T', body: 'B' }));

      expect(result).toEqual({ id: 1, indexed: false, deduplicated: false });
      expect(count(t, 'cards')).toBe(1);
      expect(count(t, 'events')).toBe(1);
      expect(count(t, 'activity_log')).toBe(1);
      expect(ftsCount(t)).toBe(1);
    });

    it('rolls back the card when the activity write fails', () => {
      breakInserts(t, 'activity_log');

      const error = captureError(() => t.cards.createCard(cardInput({ title: 'T', body: 'B' })));
      expect(error.message).toContain('injected activity_log failure');

      expect(count(t, 'cards')).toBe(0);
      expect(count(t, 'events')).toBe(0);
      expect(count(t, 'activity_log')).toBe(0);
      expect(ftsCount(t)).toBe(0);
    });

    it('rolls back the card when the event write fails', () => {
      breakInserts(t, 'events');

      const error = captureError(() => t.cards.createCard(cardInput({ title: 'T', body: 'B' })));
      expect(error.message).toContain('injected events failure');

      expect(count(t, 'cards')).toBe(0);
      expect(count(t, 'events')).toBe(0);
      expect(count(t, 'activity_log')).toBe(0);
      expect(ftsCount(t)).toBe(0);
    });

    it('rolls back when the card write itself fails', () => {
      breakInserts(t, 'cards');

      const error = captureError(() => t.cards.createCard(cardInput({ title: 'T', body: 'B' })));
      expect(error.message).toContain('injected cards failure');

      expect(count(t, 'cards')).toBe(0);
      expect(count(t, 'events')).toBe(0);
      expect(count(t, 'activity_log')).toBe(0);
      expect(ftsCount(t)).toBe(0);
    });

    it('leaves the connection usable after a rollback', () => {
      breakInserts(t, 'activity_log');
      captureError(() => t.cards.createCard(cardInput({ title: 'T', body: 'B' })));

      t.db.exec('DROP TRIGGER test_fail_activity_log');
      const result = t.cards.createCard(cardInput({ title: 'T', body: 'B' }));

      expect(result.id).toBe(1);
      expect(count(t, 'cards')).toBe(1);
      expect(count(t, 'events')).toBe(1);
      expect(count(t, 'activity_log')).toBe(1);
    });

    it('reuses an existing card for an exact duplicate without writing a second event', () => {
      const first = t.cards.createCard(cardInput({ title: 'T', body: 'B' }));
      const second = t.cards.createCard(cardInput({ title: 'T', body: 'B' }));

      expect(second).toEqual({ id: first.id, indexed: false, deduplicated: true });
      expect(count(t, 'cards')).toBe(1);
      expect(count(t, 'events')).toBe(1);
      // The duplicate is audited, so the activity log has two entries.
      expect(count(t, 'activity_log')).toBe(2);
    });
  });

  describe('updateCard', () => {
    it('keeps the card unchanged when the activity write fails', () => {
      const created = t.cards.createCard(cardInput({ title: 'T', body: 'B' }));
      const before = t.cards.getCard(created.id);

      breakInserts(t, 'activity_log');
      const error = captureError(() =>
        t.cards.updateCard(created.id, { title: 'changed', body: 'changed body' })
      );
      expect(error.message).toContain('injected activity_log failure');

      const after = t.cards.getCard(created.id);
      expect(after?.title).toBe('T');
      expect(after?.body).toBe('B');
      expect(after?.updated_at).toBe(before?.updated_at);
      // Only the original card.created row survives: the card.updated
      // event was rolled back with the rest of the transaction.
      expect(count(t, 'cards')).toBe(1);
      expect(count(t, 'events')).toBe(1);
      expect(count(t, 'activity_log')).toBe(1);
    });

    it('rolls back the card when the event write fails', () => {
      const created = t.cards.createCard(cardInput({ title: 'T', body: 'B' }));

      breakInserts(t, 'events');
      const error = captureError(() => t.cards.updateCard(created.id, { title: 'changed' }));
      expect(error.message).toContain('injected events failure');

      expect(t.cards.getCard(created.id)?.title).toBe('T');
      expect(count(t, 'events')).toBe(1);
      expect(count(t, 'activity_log')).toBe(1);
    });

    it('writes one event and one activity entry on a successful update', () => {
      const created = t.cards.createCard(cardInput({ title: 'T', body: 'B' }));
      t.cards.updateCard(created.id, { title: 'changed' });

      expect(t.cards.getCard(created.id)?.title).toBe('changed');
      expect(count(t, 'cards')).toBe(1);
      expect(count(t, 'events')).toBe(2);
      expect(count(t, 'activity_log')).toBe(2);
    });
  });

  describe('withTransaction', () => {
    it('rolls back every statement of a failed transaction', () => {
      const error = captureError(() =>
        withTransaction(t.db, () => {
          t.db
            .prepare(
              `INSERT INTO cards(title, body, type, cues, confidence, status, created_at, updated_at)
               VALUES ('T', 'B', 'fact', '[]', 0.5, 'active', '2024-01-01', '2024-01-01')`
            )
            .run();
          throw new Error('boom');
        })
      );
      expect(error.message).toBe('boom');
      expect(count(t, 'cards')).toBe(0);
    });

    it('commits every statement of a successful transaction', () => {
      withTransaction(t.db, () => {
        t.db
          .prepare(
            `INSERT INTO cards(title, body, type, cues, confidence, status, created_at, updated_at)
             VALUES ('T', 'B', 'fact', '[]', 0.5, 'active', '2024-01-01', '2024-01-01')`
          )
          .run();
      });
      expect(count(t, 'cards')).toBe(1);
    });
  });
});

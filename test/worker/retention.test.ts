import { describe, expect, it } from 'vitest';
import { DAY_MS, RETENTION_DAYS, runRetentionCleanup } from '../../src/worker/retention.js';
import { cardInput, createTestDb } from '../test-utils.js';

describe('runRetentionCleanup', () => {
  const now = new Date('2024-06-15T12:00:00Z');

  function seed(t: ReturnType<typeof createTestDb>): void {
    // Six events around the offset/age boundaries.
    for (let i = 0; i < 6; i++) {
      t.events.enqueue('card.created', { card_id: i + 1 });
    }
    const old = new Date(now.getTime() - (RETENTION_DAYS + 1) * DAY_MS).toISOString();
    const recent = new Date(now.getTime() - (RETENTION_DAYS - 1) * DAY_MS).toISOString();
    const update = (id: number, created: string, processed: string | null): void => {
      t.db
        .prepare('UPDATE events SET created_at = ?, processed_at = ? WHERE id = ?')
        .run(created, processed, id);
    };
    update(1, old, 'processed'); // old + processed + below offset -> deleted
    update(2, old, null); // old but UNPROCESSED -> kept
    update(3, recent, 'processed'); // processed + below offset but too new -> kept
    update(4, old, 'processed'); // old + processed but at/after the offset -> kept
    update(5, old, 'processed'); // old + processed but above the offset -> kept
    update(6, recent, null); // pending -> kept
  }

  it('deletes only processed events below the offset that are older than the window', () => {
    const t = createTestDb();
    try {
      seed(t);
      const offset = 4; // events 1-3 are "consumed"
      const deleted = runRetentionCleanup(t.db, offset, now);
      expect(deleted).toBe(1); // only event 1 matches every condition

      const remaining = t.events.listAll().map(e => e.id);
      expect(remaining).toEqual([2, 3, 4, 5, 6]);
    } finally {
      t.close();
    }
  });

  it('never touches the activity log', () => {
    const t = createTestDb();
    try {
      seed(t);
      t.cards.createCard(cardInput({ title: 'T', body: 'B' }));
      const before = t.activity.list(null, 100).entries.length;
      runRetentionCleanup(t.db, 6, now);
      expect(t.activity.list(null, 100).entries.length).toBe(before);
    } finally {
      t.close();
    }
  });

  it('deletes nothing when offset is 0', () => {
    const t = createTestDb();
    try {
      seed(t);
      expect(runRetentionCleanup(t.db, 0, now)).toBe(0);
      expect(t.events.listAll()).toHaveLength(6);
    } finally {
      t.close();
    }
  });
});

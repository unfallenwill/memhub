import { describe, expect, it } from 'vitest';
import { ActivityLog } from '../../src/db/activity.js';
import { createTestDb } from '../test-utils.js';

describe('ActivityLog', () => {
  it('appends entries with optional card id and detail', () => {
    const t = createTestDb();
    try {
      const log = new ActivityLog(t.db);
      log.append('hook', 'card.created', 1, { title: 'T' });
      log.append('worker', 'card.indexed', 1);
      log.append('user:web', 'card.archived', 1, null);

      const page = log.list(null, 10);
      expect(page.entries).toHaveLength(3);
      const [archived, indexed, created] = page.entries;
      expect(archived.actor).toBe('user:web');
      expect(archived.detail).toBeNull();
      expect(indexed.actor).toBe('worker');
      expect(indexed.detail).toBeNull();
      expect(created.actor).toBe('hook');
      expect(created.detail).toEqual({ title: 'T' });
      expect(created.cardId).toBe(1);
      expect(page.nextCursor).toBeNull();
    } finally {
      t.close();
    }
  });

  it('paginates newest-first with a cursor', () => {
    const t = createTestDb();
    try {
      const log = new ActivityLog(t.db);
      for (let i = 1; i <= 5; i++) {
        log.append('timer', 'job.compensation_scan', null, { n: i });
      }
      const page1 = log.list(null, 2);
      expect(page1.entries.map(e => e.id)).toEqual([5, 4]);
      expect(page1.nextCursor).toBe(4);
      const page2 = log.list(page1.nextCursor, 2);
      expect(page2.entries.map(e => e.id)).toEqual([3, 2]);
      const page3 = log.list(page2.nextCursor, 2);
      expect(page3.entries.map(e => e.id)).toEqual([1]);
      expect(page3.nextCursor).toBeNull();
    } finally {
      t.close();
    }
  });

  it('tolerates malformed detail JSON', () => {
    const t = createTestDb();
    try {
      t.db
        .prepare(
          'INSERT INTO activity_log(ts, actor, action, card_id, detail) VALUES (?, ?, ?, ?, ?)'
        )
        .run('2024-01-01T00:00:00Z', 'hook', 'card.created', null, '{broken');
      const log = new ActivityLog(t.db);
      expect(log.list(null, 10).entries[0].detail).toBeNull();
    } finally {
      t.close();
    }
  });
});

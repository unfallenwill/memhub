import { describe, expect, it } from 'vitest';
import { EventStore } from '../../src/db/events.js';
import { createTestDb } from '../test-utils.js';

describe('EventStore', () => {
  it('enqueues events with a JSON payload', () => {
    const t = createTestDb();
    try {
      t.events.enqueue('card.created', { card_id: 1 });
      const rows = t.events.listAll();
      expect(rows).toHaveLength(1);
      expect(rows[0].type).toBe('card.created');
      expect(rows[0].payload).toBe('{"card_id":1}');
      expect(rows[0].createdAt).not.toBeNull();
      expect(rows[0].processedAt).toBeNull();
      expect(rows[0].error).toBeNull();
    } finally {
      t.close();
    }
  });

  it('reports pending counts and ages', () => {
    const t = createTestDb();
    try {
      expect(t.events.stats()).toEqual({
        pendingEvents: 0,
        oldestPendingEventAgeS: 0,
      });

      t.events.enqueue('card.created', { card_id: 1 });
      const stats = t.events.stats();
      expect(stats.pendingEvents).toBe(1);
      expect(stats.oldestPendingEventAgeS).toBeGreaterThanOrEqual(0);

      t.db.prepare("UPDATE events SET created_at = '2020-01-01T00:00:00Z' WHERE id = 1").run();
      expect(t.events.stats().oldestPendingEventAgeS).toBeGreaterThan(100_000);

      // processed events no longer count as pending
      t.db.prepare('UPDATE events SET processed_at = ?').run('2024-01-01T00:00:00Z');
      expect(t.events.stats().pendingEvents).toBe(0);
    } finally {
      t.close();
    }
  });

  it('uses a shared instance against the same database', () => {
    const t = createTestDb();
    try {
      // The app creates several store instances over one connection;
      // they must observe the same rows.
      const other = new EventStore(t.db);
      t.events.enqueue('card.updated', { card_id: 7 });
      expect(other.stats().pendingEvents).toBe(1);
    } finally {
      t.close();
    }
  });
});

describe('EventStore worker consumption', () => {
  it('lists batches after an offset in id order', () => {
    const t = createTestDb();
    try {
      for (const id of [1, 2, 3]) {
        t.events.enqueue('card.created', { card_id: id });
      }
      expect(t.events.listBatchAfter(0, 2).map(e => e.id)).toEqual([1, 2]);
      expect(t.events.listBatchAfter(2, 10).map(e => e.id)).toEqual([3]);
      expect(t.events.listBatchAfter(3, 10)).toEqual([]);
      expect(t.events.listBatchAfter(99, 10)).toEqual([]);
    } finally {
      t.close();
    }
  });

  it('markProcessed sets processed_at and the error message', () => {
    const t = createTestDb();
    try {
      t.events.enqueue('card.created', { card_id: 1 });
      t.events.enqueue('card.created', { card_id: 2 });
      t.events.markProcessed(1, null);
      t.events.markProcessed(2, 'embedding failed: boom');

      const rows = t.events.listAll();
      expect(rows[0].processedAt).not.toBeNull();
      expect(rows[0].error).toBeNull();
      expect(rows[1].processedAt).not.toBeNull();
      expect(rows[1].error).toBe('embedding failed: boom');
      // Marked events no longer count as pending.
      expect(t.events.stats().pendingEvents).toBe(0);
    } finally {
      t.close();
    }
  });
});

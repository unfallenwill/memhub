import { describe, expect, it } from 'vitest';
import { InvalidSupersedeTargetError } from '../../src/db/cards.js';
import { cardInput, createTestDb, type TestDb } from '../test-utils.js';

describe('CardStore', () => {
  it('creates a card with events and activity in one transaction', () => {
    const t = createTestDb();
    try {
      const result = t.cards.createCard(cardInput({ title: 'T1', body: 'B1' }));
      expect(result).toEqual({ id: 1, indexed: false, deduplicated: false });

      const card = t.cards.getCard(1);
      expect(card).not.toBeNull();
      expect(card?.title).toBe('T1');
      expect(card?.status).toBe('active');
      expect(card?.cues).toEqual([]);
      expect(card?.confidence).toBe(0.5);
      expect(card?.indexedAt).toBeNull();
      expect(card?.hitCount).toBe(0);
      expect(card?.createdAt).toBe(card?.updatedAt);

      const events = t.events.listAll();
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('card.created');
      expect(JSON.parse(events[0].payload)).toEqual({ card_id: 1 });
      expect(events[0].processedAt).toBeNull();

      const activity = t.activity.list(null, 10);
      expect(activity.entries).toHaveLength(1);
      expect(activity.entries[0].actor).toBe('hook');
      expect(activity.entries[0].action).toBe('card.created');
      expect(activity.entries[0].cardId).toBe(1);
    } finally {
      t.close();
    }
  });

  it('reuses an existing active card for identical title+body writes', () => {
    const t = createTestDb();
    try {
      const first = t.cards.createCard(cardInput({ title: 'Same', body: 'Same body' }));
      const second = t.cards.createCard(cardInput({ title: 'Same', body: 'Same body' }));
      expect(second.id).toBe(first.id);
      expect(second.deduplicated).toBe(true);

      // no new card, no new event; one activity entry for the dedupe
      expect(t.cards.stats().total).toBe(1);
      expect(t.events.listAll()).toHaveLength(1);
      const activity = t.activity.list(null, 10);
      expect(activity.entries).toHaveLength(2);
      expect(activity.entries[0].action).toBe('card.deduplicated');

      // a different body creates a new card
      const third = t.cards.createCard(cardInput({ title: 'Same', body: 'Other body' }));
      expect(third.deduplicated).toBe(false);
      expect(third.id).not.toBe(first.id);
    } finally {
      t.close();
    }
  });

  it('does not reuse archived or superseded cards', () => {
    const t = createTestDb();
    try {
      const first = t.cards.createCard(cardInput({ title: 'X', body: 'Y' }));
      t.cards.archiveCard(first.id);
      const second = t.cards.createCard(cardInput({ title: 'X', body: 'Y' }));
      expect(second.deduplicated).toBe(false);
      expect(second.id).not.toBe(first.id);
    } finally {
      t.close();
    }
  });

  it('lists cards with filters and cursor pagination', () => {
    const t = createTestDb();
    try {
      for (let i = 1; i <= 5; i++) {
        t.cards.createCard(
          cardInput({ title: `Card ${i}`, type: i % 2 === 0 ? 'preference' : 'fact' })
        );
      }

      const all = t.cards.listCards({ limit: 10 });
      expect(all.cards.map(c => c.id)).toEqual([5, 4, 3, 2, 1]);
      expect(all.nextCursor).toBeNull();

      const page1 = t.cards.listCards({ limit: 2 });
      expect(page1.cards.map(c => c.id)).toEqual([5, 4]);
      expect(page1.nextCursor).toBe(4);

      const page2 = t.cards.listCards({ limit: 2, cursor: page1.nextCursor });
      expect(page2.cards.map(c => c.id)).toEqual([3, 2]);
      expect(page2.nextCursor).toBe(2);

      const page3 = t.cards.listCards({ limit: 2, cursor: page2.nextCursor });
      expect(page3.cards.map(c => c.id)).toEqual([1]);
      expect(page3.nextCursor).toBeNull();

      const preferences = t.cards.listCards({ limit: 10, type: 'preference' });
      expect(preferences.cards.map(c => c.id)).toEqual([4, 2]);

      t.cards.archiveCard(4);
      const active = t.cards.listCards({ limit: 10, status: 'active' });
      expect(active.cards.map(c => c.id)).toEqual([5, 3, 2, 1]);
      const archived = t.cards.listCards({ limit: 10, status: 'archived' });
      expect(archived.cards.map(c => c.id)).toEqual([4]);
    } finally {
      t.close();
    }
  });

  describe('updateCard', () => {
    it('resets indexed_at and enqueues card.updated on content change', () => {
      const t = createTestDb();
      try {
        t.cards.createCard(cardInput({ title: 'A', body: 'B', cues: ['x'] }));
        // simulate an indexed card
        t.db.prepare('UPDATE cards SET indexed_at = ? WHERE id = 1').run('2024-01-01T00:00:00Z');

        const updated = t.cards.updateCard(1, { title: 'A2' });
        expect(updated?.title).toBe('A2');
        expect(updated?.indexedAt).toBeNull();

        const events = t.events.listAll();
        expect(events).toHaveLength(2);
        expect(events[1].type).toBe('card.updated');
        expect(JSON.parse(events[1].payload)).toEqual({
          card_id: 1,
          changed: ['title'],
        });
      } finally {
        t.close();
      }
    });

    it('keeps indexed_at when only confidence changes', () => {
      const t = createTestDb();
      try {
        t.cards.createCard(cardInput());
        t.db.prepare('UPDATE cards SET indexed_at = ? WHERE id = 1').run('2024-01-01T00:00:00Z');
        const updated = t.cards.updateCard(1, { confidence: 0.9 });
        expect(updated?.confidence).toBe(0.9);
        expect(updated?.indexedAt).toBe('2024-01-01T00:00:00Z');
        expect(t.events.listAll()).toHaveLength(1); // only card.created
      } finally {
        t.close();
      }
    });

    it('returns null for unknown ids', () => {
      const t = createTestDb();
      try {
        expect(t.cards.updateCard(42, { title: 'nope' })).toBeNull();
      } finally {
        t.close();
      }
    });

    it('reports multiple changed fields', () => {
      const t = createTestDb();
      try {
        t.cards.createCard(cardInput({ title: 'A', body: 'B', cues: ['x'] }));
        t.cards.updateCard(1, { body: 'B2', cues: ['y'], type: 'decision' });
        const last = t.events.listAll()[1];
        expect(JSON.parse(last.payload).changed).toEqual(['body', 'type', 'cues']);
      } finally {
        t.close();
      }
    });
  });

  describe('archiveCard', () => {
    it('marks a card archived with archived_at', () => {
      const t = createTestDb();
      try {
        t.cards.createCard(cardInput());
        const archived = t.cards.archiveCard(1);
        expect(archived?.status).toBe('archived');
        expect(archived?.archivedAt).not.toBeNull();
        expect(t.cards.archiveCard(1)?.status).toBe('archived'); // idempotent
        expect(t.cards.archiveCard(9)).toBeNull();
      } finally {
        t.close();
      }
    });
  });

  describe('invalidateCard', () => {
    it('marks a card superseded with an optional successor', () => {
      const t = createTestDb();
      try {
        t.cards.createCard(cardInput({ title: 'old' }));
        t.cards.createCard(cardInput({ title: 'new' }));
        const invalidated = t.cards.invalidateCard(1, 2);
        expect(invalidated?.status).toBe('superseded');
        expect(invalidated?.supersededBy).toBe(2);

        const noTarget = t.cards.invalidateCard(2, null);
        expect(noTarget?.status).toBe('superseded');
        expect(noTarget?.supersededBy).toBeNull();
      } finally {
        t.close();
      }
    });

    it('rejects an unknown successor target', () => {
      const t = createTestDb();
      try {
        t.cards.createCard(cardInput());
        expect(() => t.cards.invalidateCard(1, 99)).toThrow(InvalidSupersedeTargetError);
        // the card is untouched
        expect(t.cards.getCard(1)?.status).toBe('active');
      } finally {
        t.close();
      }
    });
  });

  it('recordAccess bumps hit_count and last_accessed_at', () => {
    const t = createTestDb();
    try {
      t.cards.createCard(cardInput());
      t.cards.createCard(cardInput({ title: 'other' }));
      t.cards.recordAccess([1, 1, 2]);
      const first = t.cards.getCard(1);
      const second = t.cards.getCard(2);
      expect(first?.hitCount).toBe(2);
      expect(second?.hitCount).toBe(1);
      expect(first?.lastAccessedAt).not.toBeNull();
      expect(t.cards.recordAccess([])).toBeUndefined();
    } finally {
      t.close();
    }
  });

  it('stats counts totals, active and pending index cards', () => {
    const t = createTestDb();
    try {
      t.cards.createCard(cardInput({ title: 'a' }));
      t.cards.createCard(cardInput({ title: 'b' }));
      t.cards.archiveCard(2);
      t.db.prepare('UPDATE cards SET indexed_at = ? WHERE id = 1').run('2024-01-01T00:00:00Z');

      const stats = t.cards.stats();
      expect(stats.total).toBe(2);
      expect(stats.active).toBe(1);
      expect(stats.pendingIndex).toBe(0);
      expect(stats.oldestUnindexedAgeS).toBe(0);
    } finally {
      t.close();
    }
  });

  it('computes the age of the oldest unindexed active card', () => {
    const t = createTestDb();
    try {
      t.cards.createCard(cardInput({ title: 'old card' }));
      t.db.prepare("UPDATE cards SET created_at = '2020-01-01T00:00:00Z' WHERE id = 1").run();
      const stats = t.cards.stats();
      expect(stats.pendingIndex).toBe(1);
      expect(stats.oldestUnindexedAgeS).toBeGreaterThan(100_000);
    } finally {
      t.close();
    }
  });

  it('keeps the FTS index in sync with card content', () => {
    const t = createTestDb();
    try {
      t.cards.createCard(cardInput({ title: 'quantum tunneling', body: 'physics note' }));
      t.cards.createCard(cardInput({ title: 'cooking', body: 'pasta recipe' }));

      const count = (match: string): number => {
        const rows = t.db
          .prepare('SELECT rowid FROM cards_fts WHERE cards_fts MATCH ?')
          .all(match) as unknown as { rowid: number }[];
        return rows.length;
      };
      expect(count('"quantum"')).toBe(1);
      expect(count('"pasta"')).toBe(1);

      // update propagates
      t.cards.updateCard(1, { title: 'relativity' });
      expect(count('"quantum"')).toBe(0);
      expect(count('"relativity"')).toBe(1);
    } finally {
      t.close();
    }
  });
});

describe('CardStore error paths', () => {
  it('throws InvalidSupersedeTargetError with the target id', () => {
    const t: TestDb = createTestDb();
    try {
      t.cards.createCard(cardInput());
      try {
        t.cards.invalidateCard(1, 123);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidSupersedeTargetError);
        expect((error as InvalidSupersedeTargetError).targetId).toBe(123);
      }
    } finally {
      t.close();
    }
  });
});

describe('CardStore indexing helpers', () => {
  it('lists active unindexed cards oldest first', () => {
    const t: TestDb = createTestDb();
    try {
      t.cards.createCard(cardInput({ title: 'One', body: 'b' }));
      t.cards.createCard(cardInput({ title: 'Two', body: 'b' }));
      t.cards.createCard(cardInput({ title: 'Three', body: 'b' }));
      t.db.prepare('UPDATE cards SET indexed_at = ? WHERE id = 1').run('2024-01-01T00:00:00Z');
      t.cards.archiveCard(2);

      const unindexed = t.cards.listActiveUnindexed();
      expect(unindexed.map(c => c.id)).toEqual([3]);
    } finally {
      t.close();
    }
  });

  it('lists all active ids and resets/sets indexed_at', () => {
    const t: TestDb = createTestDb();
    try {
      t.cards.createCard(cardInput({ title: 'One', body: 'b' }));
      t.cards.createCard(cardInput({ title: 'Two', body: 'b' }));
      t.cards.archiveCard(2);
      expect(t.cards.listActiveIds()).toEqual([1]);

      t.cards.setIndexedAt([1], '2024-01-01T00:00:00Z');
      expect(t.cards.getCard(1)?.indexedAt).toBe('2024-01-01T00:00:00Z');

      t.cards.resetActiveIndexedAt();
      expect(t.cards.getCard(1)?.indexedAt).toBeNull();
      // The archived card was never indexed and stays untouched.
      expect(t.cards.stats().pendingIndex).toBe(1);
    } finally {
      t.close();
    }
  });
});

import { describe, expect, it } from 'vitest';
import { tokenize } from '../../src/db/search.js';
import { cardInput, createTestDb } from '../test-utils.js';

describe('KeywordSearch', () => {
  it('matches cards via FTS over title and body', () => {
    const t = createTestDb();
    try {
      t.cards.createCard(cardInput({ title: 'quantum tunneling', body: 'physics note' }));
      t.cards.createCard(cardInput({ title: 'cooking', body: 'pasta recipe' }));

      const hits = t.search.search('quantum', 10);
      expect(hits).toHaveLength(1);
      expect(hits[0].card.id).toBe(1);
      expect(hits[0].matchedBy).toBe('fts');
      expect(hits[0].score).toBeGreaterThan(0);

      const bodyHits = t.search.search('pasta', 10);
      expect(bodyHits.map(h => h.card.id)).toEqual([2]);
    } finally {
      t.close();
    }
  });

  it('matches cards via cues', () => {
    const t = createTestDb();
    try {
      t.cards.createCard(
        cardInput({ title: 'Deploy process', body: 'How we ship', cues: ['vercel', 'ci'] })
      );
      const hits = t.search.search('vercel', 10);
      expect(hits).toHaveLength(1);
      expect(hits[0].matchedBy).toBe('cues');
    } finally {
      t.close();
    }
  });

  it('falls back to LIKE for unindexed active cards', () => {
    const t = createTestDb();
    try {
      // card 1: indexed (vector done) - only reachable via FTS/cues
      t.cards.createCard(cardInput({ title: 'alpha', body: 'indexed body' }));
      t.db.prepare('UPDATE cards SET indexed_at = ? WHERE id = 1').run('2024-01-01T00:00:00Z');
      // card 2: unindexed, content not tokenized into FTS? (it is), but fallback
      // must still find it even when FTS misses (e.g. partial word).
      t.cards.createCard(cardInput({ title: 'unbelievable', body: 'brand new card' }));

      // partial-word query: FTS token match on prefix "unbeliev" fails,
      // fallback LIKE contains finds it.
      const hits = t.search.search('unbeliev', 10);
      expect(hits.map(h => h.card.id)).toEqual([2]);
      expect(hits[0].matchedBy).toBe('fallback');
    } finally {
      t.close();
    }
  });

  it('deduplicates by card id and prefers fts over cues over fallback', () => {
    const t = createTestDb();
    try {
      t.cards.createCard(
        cardInput({ title: 'docker', body: 'container runtime', cues: ['docker'] })
      );
      const hits = t.search.search('docker', 10);
      expect(hits).toHaveLength(1);
      expect(hits[0].matchedBy).toBe('fts');
    } finally {
      t.close();
    }
  });

  it('filters out non-active cards', () => {
    const t = createTestDb();
    try {
      t.cards.createCard(cardInput({ title: 'legacy', body: 'old decision' }));
      t.cards.archiveCard(1);
      expect(t.search.search('legacy', 10)).toHaveLength(0);
    } finally {
      t.close();
    }
  });

  it('updates hit_count and last_accessed_at for matched cards', () => {
    const t = createTestDb();
    try {
      t.cards.createCard(cardInput({ title: 'sunset', body: 'evening' }));
      t.search.search('sunset', 10);
      const card = t.cards.getCard(1);
      expect(card?.hitCount).toBe(1);
      expect(card?.lastAccessedAt).not.toBeNull();
    } finally {
      t.close();
    }
  });

  it('respects the limit and orders by score then id', () => {
    const t = createTestDb();
    try {
      t.cards.createCard(cardInput({ title: 'go memory model', body: 'go runtime details' }));
      t.cards.createCard(cardInput({ title: 'memory lane', body: 'nostalgia' }));
      const hits = t.search.search('memory', 1);
      expect(hits).toHaveLength(1);
      // both match FTS; best bm25 rank wins
      expect(['go memory model', 'memory lane']).toContain(hits[0].card.title);
    } finally {
      t.close();
    }
  });

  it('returns nothing for empty or whitespace queries', () => {
    const t = createTestDb();
    try {
      t.cards.createCard(cardInput());
      expect(t.search.search('', 10)).toHaveLength(0);
      expect(t.search.search('   ', 10)).toHaveLength(0);
    } finally {
      t.close();
    }
  });

  it('survives FTS-hostile queries with quotes and operators', () => {
    const t = createTestDb();
    try {
      t.cards.createCard(cardInput({ title: 'weird "stuff" AND things', body: 'x' }));
      expect(() => t.search.search('" AND OR NOT * (', 10)).not.toThrow();
      expect(t.search.search('weird', 10)).toHaveLength(1);
    } finally {
      t.close();
    }
  });

  it('matches multi-token queries with implicit AND', () => {
    const t = createTestDb();
    try {
      t.cards.createCard(cardInput({ title: 'postgres migrations', body: 'sql' }));
      t.cards.createCard(cardInput({ title: 'postgres backup', body: 'sql' }));
      const hits = t.search.search('postgres migrations', 10);
      expect(hits.map(h => h.card.title)).toEqual(['postgres migrations']);
    } finally {
      t.close();
    }
  });

  it('is case-insensitive', () => {
    const t = createTestDb();
    try {
      t.cards.createCard(cardInput({ title: 'Kubernetes', body: 'K8s', cues: ['Helm'] }));
      expect(t.search.search('kubernetes', 10)).toHaveLength(1);
      expect(t.search.search('K8S', 10)).toHaveLength(1);
      expect(t.search.search('helm', 10)).toHaveLength(1);
    } finally {
      t.close();
    }
  });
});

describe('tokenize', () => {
  it('splits on whitespace, lowercases and drops empties', () => {
    expect(tokenize('  Hello   WORLD  ')).toEqual(['hello', 'world']);
    expect(tokenize('')).toEqual([]);
  });
});

describe('KeywordSearch.searchUnindexed', () => {
  it('matches only unindexed active cards and records no access', () => {
    const t = createTestDb();
    try {
      t.cards.createCard(cardInput({ title: 'indexed card', body: 'needle here' }));
      t.db.prepare('UPDATE cards SET indexed_at = ? WHERE id = 1').run('2024-01-01T00:00:00Z');
      t.cards.createCard(cardInput({ title: 'fresh needle', body: 'not indexed' }));
      t.cards.createCard(cardInput({ title: 'archived needle', body: 'gone' }));
      t.cards.archiveCard(3);

      const hits = t.search.searchUnindexed('needle', 10);
      expect(hits.map(h => h.card.id)).toEqual([2]);
      expect(hits[0].matchedBy).toBe('fallback');
      // No access recording happens in the raw fallback scan.
      expect(t.cards.getCard(2)?.hitCount).toBe(0);
    } finally {
      t.close();
    }
  });

  it('returns nothing for empty queries or limits', () => {
    const t = createTestDb();
    try {
      t.cards.createCard(cardInput({ title: 'needle', body: 'b' }));
      expect(t.search.searchUnindexed('   ', 10)).toEqual([]);
      expect(t.search.searchUnindexed('needle', 0)).toEqual([]);
    } finally {
      t.close();
    }
  });
});

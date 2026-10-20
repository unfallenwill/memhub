/**
 * The keyword search backend (src/db/keyword-search.ts).
 *
 * The backend has three arms: FTS5, cue matching and a LIKE fallback
 * over the cards that are not vector-indexed yet. This file pins down
 * the degradation of the FTS arm: when the FTS index cannot be read
 * (a corrupted or missing mirror), the search must still answer through
 * the other arms instead of throwing.
 */

import { describe, expect, it } from 'vitest';
import { cardInput, createTestDb } from '../test-utils.js';

describe('KeywordSearch', () => {
  it('degrades to the other arms when the FTS index cannot be read', () => {
    const t = createTestDb();
    try {
      t.cards.createCard(cardInput({ title: 'docker compose', body: 'run the compose file' }));
      t.cards.createCard(cardInput({ title: 'unrelated', body: 'nothing to see' }));

      // Break the FTS mirror: the query throws, the search must not.
      t.db.exec('DROP TABLE cards_fts');

      const hits = t.search.search('docker', 10);

      // The FTS arm is degraded, but the fallback arm still finds the card.
      expect(hits.map(hit => hit.card.title)).toEqual(['docker compose']);
      expect(hits[0].matchedBy).toBe('fallback');
    } finally {
      t.close();
    }
  });

  it('finds a card by its cue when the FTS index cannot be read', () => {
    const t = createTestDb();
    try {
      t.cards.createCard(cardInput({ title: 'first', body: 'b', cues: ['compose'] }));
      t.db.exec('DROP TABLE cards_fts');

      const hits = t.search.search('compose', 10);

      expect(hits.map(hit => hit.card.title)).toEqual(['first']);
      expect(hits[0].matchedBy).toBe('cues');
    } finally {
      t.close();
    }
  });

  it('searches the unindexed cards with the fallback arm', () => {
    const t = createTestDb();
    try {
      t.cards.createCard(cardInput({ title: 'fresh card', body: 'body text' }));

      const hits = t.search.searchUnindexed('fresh', 10);

      expect(hits).toHaveLength(1);
      expect(hits[0].matchedBy).toBe('fallback');
    } finally {
      t.close();
    }
  });

  it('returns nothing for a blank query or a non-positive limit', () => {
    const t = createTestDb();
    try {
      t.cards.createCard(cardInput({ title: 'fresh card', body: 'body text' }));

      expect(t.search.searchUnindexed('   ', 10)).toEqual([]);
      expect(t.search.searchUnindexed('fresh', 0)).toEqual([]);
    } finally {
      t.close();
    }
  });
});

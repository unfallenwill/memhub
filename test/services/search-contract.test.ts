/**
 * Characterization test: the search contract of SearchService.
 *
 * Pins the observable behaviour of the three search modes: the order of
 * the returned cards, the score ranges, the `matched_by` classification
 * (fts / cues / fallback / semantic) and — most importantly — that one
 * search bumps `hit_count` by exactly one per returned card.
 *
 * The access bookkeeping is the fragile part of the search stack (the
 * keyword arm records access itself, the semantic arm records it once
 * after merging), so it is asserted explicitly.
 */

import { describe, expect, it } from 'vitest';
import { SearchService } from '../../src/services/search-service.js';
import { SemanticSearch } from '../../src/services/semantic-search.js';
import {
  cardInput,
  createTestDb,
  deterministicVector,
  FakeEmbedder,
  FakeVectorStore,
  type TestDb,
} from '../test-utils.js';

/** A fixture set for the keyword arms (no vector index involved). */
const KEYWORD_FIXTURES = [
  { title: 'docker deployment', body: 'containers everywhere', cues: ['ops'] },
  { title: 'unbelievable reliability', body: 'measured every week', cues: ['metrics'] },
  { title: 'unrelated note', body: 'nothing to see here', cues: ['misc'] },
  // Only the cue matches "unbeliev" on this card; the text does not.
  { title: 'service notes', body: 'unrelated body', cues: ['unbelievable'] },
] as const;

describe('SearchService contract', () => {
  /** Keyword-only fixture: four cards, ids 1..4. */
  function keywordSetup(): TestDb {
    const t = createTestDb();
    for (const fixture of KEYWORD_FIXTURES) {
      t.cards.createCard(cardInput(fixture));
    }
    return t;
  }

  /** Fixture with a vector index: card 1 indexed, card 2 still unindexed. */
  function semanticSetup(): {
    t: TestDb;
    semantic: SemanticSearch;
    vectors: FakeVectorStore;
  } {
    const t = createTestDb();
    const vectors = new FakeVectorStore();
    const semantic = new SemanticSearch({
      embedder: new FakeEmbedder(),
      vectors,
      cards: t.cards,
    });
    const indexed = t.cards.createCard(
      cardInput({ title: 'alpha card', body: 'stored in the vector index', cues: ['alpha'] })
    );
    // Card 1 is indexed and its vector is the query vector -> distance 0.
    void vectors.upsert(indexed.id, deterministicVector('needle'));
    t.db
      .prepare('UPDATE cards SET indexed_at = ? WHERE id = ?')
      .run('2024-01-01T00:00:00Z', indexed.id);
    // Card 2 stays unindexed: it can only be found through the fallback.
    t.cards.createCard(
      cardInput({ title: 'fresh needle card', body: 'not indexed yet', cues: ['beta'] })
    );
    return { t, semantic, vectors };
  }

  describe('keyword mode', () => {
    it('matches indexed text through FTS', async () => {
      const t = keywordSetup();
      try {
        const service = new SearchService({ cards: t.cards, keyword: t.search, semantic: null });
        const outcome = await service.search('docker', 'keyword', 10);
        expect(outcome.modeUsed).toBe('keyword');
        expect(outcome.results.map(r => r.card.id)).toEqual([1]);
        expect(outcome.results.map(r => r.matchedBy)).toEqual(['fts']);
        const score = outcome.results[0]!.score;
        expect(score).toBeGreaterThan(0);
        expect(score).toBeLessThanOrEqual(1);
      } finally {
        t.close();
      }
    });

    it('matches cues and scores them below FTS hits', async () => {
      const t = keywordSetup();
      try {
        const service = new SearchService({ cards: t.cards, keyword: t.search, semantic: null });
        const outcome = await service.search('ops', 'keyword', 10);
        expect(outcome.results.map(r => r.card.id)).toEqual([1]);
        expect(outcome.results.map(r => r.matchedBy)).toEqual(['cues']);
        expect(outcome.results[0]!.score).toBeCloseTo(0.5, 5);
      } finally {
        t.close();
      }
    });

    it('finds an unindexed card through the fallback (indexed_at is null)', async () => {
      const t = keywordSetup();
      try {
        const service = new SearchService({ cards: t.cards, keyword: t.search, semantic: null });
        const outcome = await service.search('unbeliev', 'keyword', 10);
        expect(outcome.results.map(r => r.card.id)).toContain(2);
        const hit = outcome.results.find(r => r.card.id === 2)!;
        expect(hit.matchedBy).toBe('fallback');
        expect(hit.score).toBeCloseTo(0.25, 5);
        // The card was never vector-indexed; the fallback found it anyway.
        expect(hit.card.indexedAt).toBeNull();
      } finally {
        t.close();
      }
    });

    it('orders results by score descending', async () => {
      const t = keywordSetup();
      try {
        const service = new SearchService({ cards: t.cards, keyword: t.search, semantic: null });
        const outcome = await service.search('unbeliev', 'keyword', 10);
        // Card 4 matches through its cue (0.5), card 2 through the
        // fallback (0.25): the higher score comes first even though the
        // card id is larger.
        expect(outcome.results.map(r => r.card.id)).toEqual([4, 2]);
        expect(outcome.results.map(r => r.matchedBy)).toEqual(['cues', 'fallback']);
      } finally {
        t.close();
      }
    });

    it('bumps hit_count by exactly one per search', async () => {
      const t = keywordSetup();
      try {
        const service = new SearchService({ cards: t.cards, keyword: t.search, semantic: null });
        expect(t.cards.getCard(1)?.hitCount).toBe(0);

        await service.search('docker', 'keyword', 10);
        expect(t.cards.getCard(1)?.hitCount).toBe(1);
        expect(t.cards.getCard(1)?.lastAccessedAt).not.toBeNull();
        // Cards that did not match are untouched.
        expect(t.cards.getCard(2)?.hitCount).toBe(0);
        expect(t.cards.getCard(3)?.hitCount).toBe(0);
        expect(t.cards.getCard(4)?.hitCount).toBe(0);

        await service.search('docker', 'keyword', 10);
        expect(t.cards.getCard(1)?.hitCount).toBe(2);
      } finally {
        t.close();
      }
    });

    it('respects the limit', async () => {
      const t = keywordSetup();
      try {
        const service = new SearchService({ cards: t.cards, keyword: t.search, semantic: null });
        const outcome = await service.search('unbeliev', 'keyword', 1);
        expect(outcome.results).toHaveLength(1);
        expect(outcome.results[0]!.card.id).toBe(4);
      } finally {
        t.close();
      }
    });
  });

  describe('auto mode', () => {
    it('degrades to keyword while the index is not ready', async () => {
      const t = keywordSetup();
      try {
        const service = new SearchService({ cards: t.cards, keyword: t.search, semantic: null });
        const outcome = await service.search('docker', 'auto', 10);
        expect(outcome.modeUsed).toBe('keyword');
        expect(outcome.results.map(r => r.card.id)).toEqual([1]);
        expect(outcome.results.map(r => r.matchedBy)).toEqual(['fts']);
      } finally {
        t.close();
      }
    });

    it('uses semantic mode once the index is ready', async () => {
      const { t, semantic } = semanticSetup();
      try {
        const service = new SearchService({ cards: t.cards, keyword: t.search, semantic });
        semantic.setReady(true);
        const outcome = await service.search('needle', 'auto', 10);
        expect(outcome.modeUsed).toBe('semantic');
        expect(outcome.results.map(r => r.matchedBy)).toEqual(['semantic', 'fallback']);
      } finally {
        t.close();
      }
    });
  });

  describe('semantic mode', () => {
    it('merges vector hits with the unindexed fallback, semantic hits first', async () => {
      const { t, semantic } = semanticSetup();
      try {
        const service = new SearchService({ cards: t.cards, keyword: t.search, semantic });
        semantic.setReady(true);
        const outcome = await service.search('needle', 'semantic', 10);

        expect(outcome.modeUsed).toBe('semantic');
        expect(outcome.results.map(r => r.card.id)).toEqual([1, 2]);
        expect(outcome.results.map(r => r.matchedBy)).toEqual(['semantic', 'fallback']);
        // The indexed card matches its own query vector exactly.
        expect(outcome.results[0]!.score).toBeCloseTo(1, 5);
        expect(outcome.results[0]!.score).toBeLessThanOrEqual(1);
        // The unindexed card is only reachable through the fallback.
        expect(outcome.results[1]!.score).toBeCloseTo(0.25, 5);
        expect(outcome.results[1]!.card.indexedAt).toBeNull();
      } finally {
        t.close();
      }
    });

    it('bumps hit_count by exactly one for every merged result', async () => {
      const { t, semantic } = semanticSetup();
      try {
        const service = new SearchService({ cards: t.cards, keyword: t.search, semantic });
        semantic.setReady(true);
        await service.search('needle', 'semantic', 10);

        expect(t.cards.getCard(1)?.hitCount).toBe(1);
        expect(t.cards.getCard(2)?.hitCount).toBe(1);

        await service.search('needle', 'semantic', 10);
        expect(t.cards.getCard(1)?.hitCount).toBe(2);
        expect(t.cards.getCard(2)?.hitCount).toBe(2);
      } finally {
        t.close();
      }
    });

    it('never returns a card twice', async () => {
      const { t, semantic } = semanticSetup();
      try {
        const service = new SearchService({ cards: t.cards, keyword: t.search, semantic });
        semantic.setReady(true);
        const outcome = await service.search('needle', 'semantic', 10);
        const ids = outcome.results.map(r => r.card.id);
        expect(new Set(ids).size).toBe(ids.length);
      } finally {
        t.close();
      }
    });

    it('truncates the merged list to the limit', async () => {
      const { t, semantic } = semanticSetup();
      try {
        const service = new SearchService({ cards: t.cards, keyword: t.search, semantic });
        semantic.setReady(true);
        const outcome = await service.search('needle', 'semantic', 1);
        expect(outcome.results).toHaveLength(1);
        expect(outcome.results[0]!.card.id).toBe(1);
      } finally {
        t.close();
      }
    });
  });
});

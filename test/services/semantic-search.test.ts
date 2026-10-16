import { describe, expect, it } from 'vitest';
import { distanceToScore, SemanticSearch } from '../../src/services/semantic-search.js';
import {
  cardInput,
  createTestDb,
  deterministicVector,
  FakeEmbedder,
  FakeVectorStore,
} from '../test-utils.js';

describe('distanceToScore', () => {
  it('maps normalized-vector distances to a 0..1 similarity', () => {
    expect(distanceToScore(0)).toBe(1);
    expect(distanceToScore(2)).toBe(0);
    expect(distanceToScore(1)).toBeCloseTo(0.5, 10);
    // Out-of-range distances are clamped.
    expect(distanceToScore(-1)).toBe(1);
    expect(distanceToScore(5)).toBe(0);
  });
});

describe('SemanticSearch', () => {
  it('finds cards by query vector and joins back to SQLite', async () => {
    const t = createTestDb();
    try {
      const created = t.cards.createCard(cardInput({ title: 'docker', body: 'deploy' }));
      const embedder = new FakeEmbedder();
      const vectors = new FakeVectorStore();
      // Simulate the card having been indexed with the query's vector.
      await vectors.upsert(created.id, deterministicVector('needle'));
      const semantic = new SemanticSearch({ embedder, vectors, cards: t.cards });

      const hits = await semantic.search('needle', 10);
      expect(hits).toHaveLength(1);
      expect(hits[0].card.id).toBe(created.id);
      expect(hits[0].score).toBeCloseTo(1, 5);
      // Search itself does not record access.
      expect(t.cards.getCard(created.id)?.hitCount).toBe(0);
    } finally {
      t.close();
    }
  });

  it('filters out non-active and missing cards', async () => {
    const t = createTestDb();
    try {
      const active = t.cards.createCard(cardInput({ title: 'keep', body: 'b' }));
      const archived = t.cards.createCard(cardInput({ title: 'drop', body: 'b' }));
      t.cards.archiveCard(archived.id);

      const embedder = new FakeEmbedder();
      const vectors = new FakeVectorStore();
      await vectors.upsert(active.id, deterministicVector('needle'));
      await vectors.upsert(archived.id, deterministicVector('needle'));
      // A vector pointing at a card that no longer exists.
      await vectors.upsert(999, deterministicVector('needle'));
      const semantic = new SemanticSearch({ embedder, vectors, cards: t.cards });

      const hits = await semantic.search('needle', 10);
      expect(hits.map(h => h.card.id)).toEqual([active.id]);
    } finally {
      t.close();
    }
  });

  it('returns nothing for limit 0', async () => {
    const t = createTestDb();
    try {
      const semantic = new SemanticSearch({
        embedder: new FakeEmbedder(),
        vectors: new FakeVectorStore(),
        cards: t.cards,
      });
      expect(await semantic.search('x', 0)).toEqual([]);
    } finally {
      t.close();
    }
  });

  it('readiness is managed externally', () => {
    const t = createTestDb();
    try {
      const semantic = new SemanticSearch({
        embedder: new FakeEmbedder(),
        vectors: new FakeVectorStore(),
        cards: t.cards,
      });
      expect(semantic.ready).toBe(false);
      semantic.setReady(true);
      expect(semantic.ready).toBe(true);
    } finally {
      t.close();
    }
  });
});

/**
 * The failure paths of the vector index rebuild (src/worker/rebuild.ts).
 *
 * A card whose embedding fails keeps indexed_at = NULL so the hourly
 * compensation scan can retry it; the rebuild itself must not throw.
 */

import { describe, expect, it } from 'vitest';
import type { EmbeddingProvider } from '../../src/core/ports/embedding.js';
import { createDbContext } from '../../src/db/context.js';
import { rebuildVectorIndex } from '../../src/worker/rebuild.js';
import { cardInput, createTestDb, FakeEmbedder, FakeVectorStore } from '../test-utils.js';

/** A provider that fails on every call. */
const failingEmbedder: EmbeddingProvider = {
  modelId: 'failing-embedder',
  dimensions: 8,
  ensureLoaded: async () => {},
  embed: async () => {
    throw new Error('the model is not available');
  },
};

/** A provider that answers with fewer vectors than it was given texts. */
const shortEmbedder: EmbeddingProvider = {
  modelId: 'short-embedder',
  dimensions: 8,
  ensureLoaded: async () => {},
  embed: async () => [],
};

describe('a rebuild whose embedding fails', () => {
  it('counts the cards as failed and keeps them unindexed', async () => {
    const t = createTestDb();
    try {
      t.cards.createCard(cardInput({ title: 'One', body: 'b1' }));
      t.cards.createCard(cardInput({ title: 'Two', body: 'b2' }));

      const result = await rebuildVectorIndex({
        repositories: createDbContext(t.db),
        embedder: failingEmbedder,
        vectors: new FakeVectorStore(),
      });

      expect(result.indexed).toBe(0);
      expect(result.failed).toBe(2);
      expect(t.cards.getCard(1)?.indexedAt).toBeNull();
      expect(t.cards.getCard(2)?.indexedAt).toBeNull();
    } finally {
      t.close();
    }
  });

  it('counts a card the provider did not answer with a vector as failed', async () => {
    const t = createTestDb();
    try {
      t.cards.createCard(cardInput({ title: 'One', body: 'b1' }));

      const result = await rebuildVectorIndex({
        repositories: createDbContext(t.db),
        embedder: shortEmbedder,
        vectors: new FakeVectorStore(),
      });

      expect(result.indexed).toBe(0);
      expect(result.failed).toBe(1);
      expect(t.cards.getCard(1)?.indexedAt).toBeNull();
    } finally {
      t.close();
    }
  });

  it('reports the progress of the rebuild', async () => {
    const t = createTestDb();
    try {
      t.cards.createCard(cardInput({ title: 'One', body: 'b1' }));
      const progress: number[] = [];

      const result = await rebuildVectorIndex({
        repositories: createDbContext(t.db),
        embedder: new FakeEmbedder(),
        vectors: new FakeVectorStore(),
        onProgress: done => progress.push(done),
      });

      expect(result.indexed).toBe(1);
      expect(progress).toContain(1);
    } finally {
      t.close();
    }
  });
});

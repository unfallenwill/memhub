/**
 * The empty result of the semantic search (src/services/semantic-search.ts).
 *
 * A provider that answers a query with no vector at all cannot be
 * searched; the service answers with an empty list instead of failing
 * the request.
 */

import { describe, expect, it } from 'vitest';
import type { EmbeddingProvider } from '../../src/core/ports/embedding.js';
import { SemanticSearch } from '../../src/services/semantic-search.js';
import { createTestDb, FakeVectorStore } from '../test-utils.js';

/** A provider that returns no vector for the query. */
const emptyEmbedder: EmbeddingProvider = {
  modelId: 'empty-embedder',
  dimensions: 0,
  ensureLoaded: async () => {},
  embed: async () => [],
};

describe('a query without a vector', () => {
  it('answers with an empty list', async () => {
    const t = createTestDb();
    try {
      const semantic = new SemanticSearch({
        embedder: emptyEmbedder,
        vectors: new FakeVectorStore(),
        cards: t.cards,
      });

      expect(await semantic.search('needle', 10)).toEqual([]);
    } finally {
      t.close();
    }
  });
});

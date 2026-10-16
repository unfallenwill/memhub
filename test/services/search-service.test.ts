import { describe, expect, it } from 'vitest';
import {
  IndexNotReadyError,
  SearchService,
  SemanticStackNotInstalledError,
} from '../../src/services/search-service.js';
import { SemanticSearch } from '../../src/services/semantic-search.js';
import {
  cardInput,
  createTestDb,
  deterministicVector,
  FakeEmbedder,
  FakeVectorStore,
} from '../test-utils.js';

describe('SearchService', () => {
  function setup() {
    const t = createTestDb();
    const embedder = new FakeEmbedder();
    const vectors = new FakeVectorStore();
    const semantic = new SemanticSearch({ embedder, vectors, cards: t.cards });
    const service = new SearchService({ cards: t.cards, keyword: t.search, semantic });
    return { t, embedder, vectors, semantic, service };
  }

  /** Create a card that is vector-indexed with the given query's vector. */
  function indexCardForQuery(
    t: ReturnType<typeof createTestDb>,
    vectors: FakeVectorStore,
    query: string,
    input: { title: string; body: string }
  ): number {
    const created = t.cards.createCard(cardInput(input));
    void vectors.upsert(created.id, deterministicVector(query));
    t.db
      .prepare('UPDATE cards SET indexed_at = ? WHERE id = ?')
      .run('2024-01-01T00:00:00Z', created.id);
    return created.id;
  }

  it('keyword mode uses FTS/cues plus the unindexed fallback', async () => {
    const { t, service } = setup();
    try {
      t.cards.createCard(cardInput({ title: 'docker deploy', body: 'containers' }));
      t.cards.createCard(cardInput({ title: 'unbelievable', body: 'brand new' }));
      const outcome = await service.search('unbeliev', 'keyword', 10);
      expect(outcome.modeUsed).toBe('keyword');
      expect(outcome.results.map(r => r.card.title)).toEqual(['unbelievable']);
      expect(outcome.results[0].matchedBy).toBe('fallback');
    } finally {
      t.close();
    }
  });

  it('semantic mode throws IndexNotReadyError while the index is not ready', async () => {
    const { t, service } = setup();
    try {
      await expect(service.search('x', 'semantic', 10)).rejects.toBeInstanceOf(IndexNotReadyError);
    } finally {
      t.close();
    }
  });

  it('auto mode degrades to keyword while the index is not ready', async () => {
    const { t, service } = setup();
    try {
      t.cards.createCard(cardInput({ title: 'docker deploy', body: 'containers' }));
      const outcome = await service.search('docker', 'auto', 10);
      expect(outcome.modeUsed).toBe('keyword');
      expect(outcome.results).toHaveLength(1);
    } finally {
      t.close();
    }
  });

  it('semantic mode throws SemanticStackNotInstalledError when the stack is missing', async () => {
    const { t, semantic, service } = setup();
    try {
      semantic.markNotInstalled();
      await expect(service.search('x', 'semantic', 10)).rejects.toBeInstanceOf(
        SemanticStackNotInstalledError
      );
      // The message tells users how to install the stack.
      const error = await service.search('x', 'semantic', 10).catch(caught => caught);
      expect((error as Error).message).toContain('npm install');
    } finally {
      t.close();
    }
  });

  it('auto mode still degrades to keyword when the stack is missing', async () => {
    const { t, semantic, service } = setup();
    try {
      t.cards.createCard(cardInput({ title: 'docker deploy', body: 'containers' }));
      semantic.markNotInstalled();
      const outcome = await service.search('docker', 'auto', 10);
      expect(outcome.modeUsed).toBe('keyword');
      expect(outcome.results).toHaveLength(1);
    } finally {
      t.close();
    }
  });

  it('setReady clears the not-installed state', async () => {
    const { t, vectors, semantic, service } = setup();
    try {
      indexCardForQuery(t, vectors, 'needle', { title: 'indexed', body: 'body' });
      semantic.markNotInstalled();
      semantic.setReady(true);
      expect(semantic.notInstalled).toBe(false);
      const outcome = await service.search('needle', 'semantic', 10);
      expect(outcome.modeUsed).toBe('semantic');
    } finally {
      t.close();
    }
  });

  it('semantic mode merges vector hits with the unindexed keyword fallback', async () => {
    const { t, vectors, semantic, service } = setup();
    try {
      const indexedId = indexCardForQuery(t, vectors, 'needle', {
        title: 'indexed card',
        body: 'stored in lance',
      });
      t.cards.createCard(cardInput({ title: 'fresh unindexed needle', body: 'just written' }));

      semantic.setReady(true);
      const outcome = await service.search('needle', 'semantic', 10);

      expect(outcome.modeUsed).toBe('semantic');
      expect(outcome.results.map(r => r.card.id)).toEqual([indexedId, 2]);
      expect(outcome.results[0].matchedBy).toBe('semantic');
      expect(outcome.results[1].matchedBy).toBe('fallback');

      // Access was recorded once for every final hit.
      expect(t.cards.getCard(indexedId)?.hitCount).toBe(1);
      expect(t.cards.getCard(2)?.hitCount).toBe(1);
    } finally {
      t.close();
    }
  });

  it('deduplicates by card id when a card matches semantically and by keyword', async () => {
    const { t, vectors, semantic, service } = setup();
    try {
      // An unindexed card whose text contains the query would normally be
      // matched by the fallback; here it is also the semantic hit after
      // being indexed mid-request is impossible, so simulate the overlap
      // by leaving it unindexed while its vector exists.
      const created = t.cards.createCard(
        cardInput({ title: 'needle card', body: 'about needles' })
      );
      void vectors.upsert(created.id, deterministicVector('needle'));

      semantic.setReady(true);
      const outcome = await service.search('needle', 'semantic', 10);
      const ids = outcome.results.map(r => r.card.id);
      expect(ids.filter(id => id === created.id)).toHaveLength(1);
      expect(outcome.results[0].matchedBy).toBe('semantic');
    } finally {
      t.close();
    }
  });

  it('auto mode uses semantic search once the index is ready', async () => {
    const { t, vectors, semantic, service } = setup();
    try {
      indexCardForQuery(t, vectors, 'needle', { title: 'indexed', body: 'body' });
      semantic.setReady(true);
      const outcome = await service.search('needle', 'auto', 10);
      expect(outcome.modeUsed).toBe('semantic');
      expect(outcome.results).toHaveLength(1);
    } finally {
      t.close();
    }
  });

  it('respects the limit across semantic and fallback hits', async () => {
    const { t, vectors, semantic, service } = setup();
    try {
      indexCardForQuery(t, vectors, 'needle', { title: 'indexed one', body: 'b' });
      indexCardForQuery(t, vectors, 'needle', { title: 'indexed two', body: 'b' });
      t.cards.createCard(cardInput({ title: 'unindexed needle', body: 'b' }));

      semantic.setReady(true);
      const outcome = await service.search('needle', 'semantic', 2);
      expect(outcome.results).toHaveLength(2);
    } finally {
      t.close();
    }
  });

  it('works without any semantic backend for keyword and auto', async () => {
    const t = createTestDb();
    try {
      const service = new SearchService({ cards: t.cards, keyword: t.search, semantic: null });
      t.cards.createCard(cardInput({ title: 'docker', body: 'b' }));
      expect((await service.search('docker', 'auto', 10)).modeUsed).toBe('keyword');
      expect((await service.search('docker', 'keyword', 10)).results).toHaveLength(1);
      await expect(service.search('docker', 'semantic', 10)).rejects.toBeInstanceOf(
        IndexNotReadyError
      );
    } finally {
      t.close();
    }
  });
});

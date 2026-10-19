import { describe, expect, it } from 'vitest';
import {
  IndexNotReadyError,
  isIndexReady,
  SearchService,
  SemanticStackNotInstalledError,
} from '../../src/services/search-service.js';
import { SemanticSearch } from '../../src/services/semantic-search.js';
import type { SearchHit } from '../../src/core/domain/types.js';
import type { SemanticHit } from '../../src/core/ports/search.js';
import {
  cardInput,
  createTestDb,
  deterministicVector,
  FakeEmbedder,
  FakeVectorStore,
} from '../test-utils.js';
import {
  fakeCard,
  fakeHit,
  FakeCardRepository,
  FakeKeywordSearch,
  FakeSemanticSearch,
} from './fakes.js';

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

/**
 * The service is written against ports, so it can be driven by plain
 * in-memory stubs - no database, no SQL. These cases pin the mode
 * routing and the access bookkeeping, which is the fragile part of the
 * search stack.
 */
describe('SearchService (port stubs)', () => {
  /** The state of the semantic backend a test wants. */
  type SemanticState = 'none' | 'not-ready' | 'ready' | 'not-installed';

  function setup(
    options: {
      readonly keywordHits?: readonly SearchHit[];
      readonly unindexedHits?: readonly SearchHit[];
      readonly semanticHits?: readonly SemanticHit[];
      readonly semantic?: SemanticState;
    } = {}
  ) {
    const cards = new FakeCardRepository();
    const keyword = new FakeKeywordSearch(options.keywordHits ?? [], options.unindexedHits ?? []);
    let semantic: FakeSemanticSearch | null = null;
    const state = options.semantic ?? 'none';
    if (state !== 'none') {
      semantic = new FakeSemanticSearch(options.semanticHits ?? []);
      semantic.ready = state === 'ready';
      semantic.notInstalled = state === 'not-installed';
    }
    const service = new SearchService({ cards, keyword, semantic });
    return { cards, keyword, semantic, service };
  }

  it('keyword mode asks the keyword backend and ignores the semantic one', async () => {
    const keywordHits = [fakeHit(fakeCard({ id: 1 }), 1, 'fts')];
    const { service, keyword, semantic } = setup({
      keywordHits,
      semantic: 'ready',
      semanticHits: [{ card: fakeCard({ id: 2 }), score: 1 }],
    });

    const outcome = await service.search('needle', 'keyword', 10);

    expect(outcome.modeUsed).toBe('keyword');
    expect(outcome.results.map(r => r.card.id)).toEqual([1]);
    expect(keyword.searchCalls).toEqual([{ query: 'needle', limit: 10 }]);
    expect(semantic?.calls).toEqual([]);
  });

  it('auto mode uses the semantic backend once the index is ready', async () => {
    const { service, keyword, semantic } = setup({
      semantic: 'ready',
      semanticHits: [{ card: fakeCard({ id: 7 }), score: 0.9 }],
    });

    const outcome = await service.search('needle', 'auto', 10);

    expect(outcome.modeUsed).toBe('semantic');
    expect(outcome.results.map(r => r.card.id)).toEqual([7]);
    expect(outcome.results[0].matchedBy).toBe('semantic');
    expect(semantic?.calls).toEqual([{ query: 'needle', limit: 10 }]);
    // The keyword arm is only used for the unindexed fallback.
    expect(keyword.searchCalls).toEqual([]);
    expect(keyword.unindexedCalls).toEqual([{ query: 'needle', limit: 10 }]);
  });

  it('auto mode degrades to keyword while the index is not ready', async () => {
    const { service, semantic } = setup({
      keywordHits: [fakeHit(fakeCard({ id: 1 }), 1, 'fts')],
      semantic: 'not-ready',
    });

    const outcome = await service.search('needle', 'auto', 10);

    expect(outcome.modeUsed).toBe('keyword');
    expect(outcome.results.map(r => r.card.id)).toEqual([1]);
    expect(semantic?.calls).toEqual([]);
  });

  it('auto mode degrades to keyword when the semantic stack is missing', async () => {
    const { service, semantic } = setup({
      keywordHits: [fakeHit(fakeCard({ id: 1 }), 1, 'fts')],
      semantic: 'not-installed',
    });

    const outcome = await service.search('needle', 'auto', 10);

    expect(outcome.modeUsed).toBe('keyword');
    expect(outcome.results.map(r => r.card.id)).toEqual([1]);
    expect(semantic?.calls).toEqual([]);
  });

  it('semantic mode throws IndexNotReadyError while the index is not ready', async () => {
    const { service } = setup({ semantic: 'not-ready' });
    await expect(service.search('needle', 'semantic', 10)).rejects.toBeInstanceOf(
      IndexNotReadyError
    );
  });

  it('semantic mode throws SemanticStackNotInstalledError when the stack is missing', async () => {
    const { service } = setup({ semantic: 'not-installed' });
    const error = await service.search('needle', 'semantic', 10).catch(caught => caught);
    expect(error).toBeInstanceOf(SemanticStackNotInstalledError);
    expect((error as Error).message).toContain('npm install');
  });

  it('semantic mode throws IndexNotReadyError without a semantic backend', async () => {
    const { service } = setup({ semantic: 'none' });
    await expect(service.search('needle', 'semantic', 10)).rejects.toBeInstanceOf(
      IndexNotReadyError
    );
  });

  it('merges the semantic hits first, the unindexed keyword hits after', async () => {
    const { service } = setup({
      semantic: 'ready',
      semanticHits: [{ card: fakeCard({ id: 1 }), score: 0.8 }],
      unindexedHits: [fakeHit(fakeCard({ id: 2 }), 0.25, 'fallback')],
    });

    const outcome = await service.search('needle', 'semantic', 10);

    expect(outcome.results.map(r => r.card.id)).toEqual([1, 2]);
    expect(outcome.results.map(r => r.matchedBy)).toEqual(['semantic', 'fallback']);
  });

  it('returns a card once when it matches semantically and by keyword', async () => {
    const shared = fakeCard({ id: 3 });
    const { service } = setup({
      semantic: 'ready',
      semanticHits: [{ card: shared, score: 0.8 }],
      unindexedHits: [fakeHit(shared, 0.25, 'fallback')],
    });

    const outcome = await service.search('needle', 'semantic', 10);

    expect(outcome.results).toHaveLength(1);
    expect(outcome.results[0].matchedBy).toBe('semantic');
  });

  it('truncates the merged result set to the limit', async () => {
    const { service } = setup({
      semantic: 'ready',
      semanticHits: [
        { card: fakeCard({ id: 1 }), score: 0.9 },
        { card: fakeCard({ id: 2 }), score: 0.8 },
      ],
      unindexedHits: [
        fakeHit(fakeCard({ id: 3 }), 0.25, 'fallback'),
        fakeHit(fakeCard({ id: 4 }), 0.25, 'fallback'),
      ],
    });

    const outcome = await service.search('needle', 'semantic', 2);

    expect(outcome.results).toHaveLength(2);
    expect(outcome.results.map(r => r.card.id)).toEqual([1, 2]);
  });

  it('records the access exactly once, for the returned cards only', async () => {
    const { service, cards } = setup({
      keywordHits: [
        fakeHit(fakeCard({ id: 1 }), 1, 'fts'),
        fakeHit(fakeCard({ id: 2 }), 0.5, 'cues'),
      ],
    });

    await service.search('needle', 'keyword', 10);

    expect(cards.accessCalls).toEqual([[1, 2]]);
  });

  it('records the access once for the merged semantic result set', async () => {
    const { service, cards } = setup({
      semantic: 'ready',
      semanticHits: [{ card: fakeCard({ id: 1 }), score: 0.9 }],
      unindexedHits: [fakeHit(fakeCard({ id: 2 }), 0.25, 'fallback')],
    });

    await service.search('needle', 'semantic', 10);

    expect(cards.accessCalls).toEqual([[1, 2]]);
  });

  it('records no access when the search fails', async () => {
    const { service, cards } = setup({ semantic: 'not-ready' });

    await expect(service.search('needle', 'semantic', 10)).rejects.toBeInstanceOf(
      IndexNotReadyError
    );
    expect(cards.accessCalls).toEqual([]);
  });

  it('records the access of the truncated result set only', async () => {
    const { service, cards } = setup({
      keywordHits: [
        fakeHit(fakeCard({ id: 1 }), 1, 'fts'),
        fakeHit(fakeCard({ id: 2 }), 0.5, 'cues'),
        fakeHit(fakeCard({ id: 3 }), 0.25, 'fallback'),
      ],
    });

    await service.search('needle', 'keyword', 2);

    expect(cards.accessCalls).toEqual([[1, 2]]);
  });
});

describe('isIndexReady', () => {
  it('follows the semantic backend when one is injected', () => {
    const semantic = new FakeSemanticSearch();
    expect(isIndexReady(semantic)).toBe(false);
    semantic.ready = true;
    expect(isIndexReady(semantic)).toBe(true);
  });

  it('falls back to the model and the pending count without a backend', () => {
    expect(isIndexReady(null, 'model-id', 0)).toBe(true);
    expect(isIndexReady(undefined, 'model-id', 0)).toBe(true);
    expect(isIndexReady(null, 'model-id', 3)).toBe(false);
    expect(isIndexReady(null, null, 0)).toBe(false);
  });
});

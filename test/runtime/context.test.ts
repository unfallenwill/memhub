/**
 * The composition root.
 *
 * There must be exactly ONE store graph per process. The HTTP app, the
 * indexing worker, the job timers and the semantic search all work on
 * the instances the context built.
 *
 * The tests below prove it by spying on the context's own instances: a
 * consumer that assembled a store of its own would never trigger the
 * spy. That is stronger than comparing the exposed properties - it
 * checks what the consumers actually call.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTransactionRunner } from '../../src/db/database.js';
import { createApp } from '../../src/http/app.js';
import { createRuntimeContext, type RuntimeContext } from '../../src/runtime/context.js';
import { SemanticSearch } from '../../src/services/semantic-search.js';
import { IndexingWorker } from '../../src/worker/indexer-worker.js';
import type { WorkerRepositories } from '../../src/worker/repositories.js';
import { JobTimers } from '../../src/worker/timers.js';
import {
  cardInput,
  createTestDb,
  FakeEmbedder,
  FakeVectorStore,
  MutableClock,
  type TestDb,
} from '../test-utils.js';

/** Loopback env: the Host check fails closed without socket info. */
const LOCAL_ENV = { incoming: { socket: { remoteAddress: '127.0.0.1' } } };

const TOKEN = 'context-token';

describe('createRuntimeContext', () => {
  let t: TestDb;

  beforeEach(() => {
    t = createTestDb();
  });

  afterEach(() => {
    t.close();
  });

  it('binds the transaction runner of the database', () => {
    const context = createRuntimeContext({ db: t.db });
    // One runner per connection: the context and the stores agree on the
    // transaction depth, so a nested transaction is still rejected.
    expect(context.transactions).toBe(getTransactionRunner(t.db));
  });

  it('records the search access through its own card repository', async () => {
    const context = createRuntimeContext({ db: t.db });
    context.cards.createCard(cardInput({ title: 'docker', body: 'containers' }));

    const outcome = await context.search.search('docker', 'keyword', 10);
    expect(outcome.modeUsed).toBe('keyword');
    expect(context.cards.getCard(1)?.hitCount).toBe(1);
  });

  it('runs keyword-only when no semantic stack is given', () => {
    const context = createRuntimeContext({ db: t.db });
    expect(context.semantic).toBeNull();
  });

  it('runs keyword-only when keyword-only mode is requested', () => {
    const context = createRuntimeContext({
      db: t.db,
      embedder: new FakeEmbedder(),
      vectors: new FakeVectorStore(),
      keywordOnly: true,
    });
    expect(context.semantic).toBeNull();
  });

  it('builds the semantic backend when the stack is given', () => {
    const context = createRuntimeContext({
      db: t.db,
      embedder: new FakeEmbedder(),
      vectors: new FakeVectorStore(),
    });
    expect(context.semantic).not.toBeNull();
  });

  it('uses the injected clock', () => {
    const clock = new MutableClock('2024-05-06T07:08:09.000Z');
    const context = createRuntimeContext({ db: t.db, clock });
    const created = context.cards.createCard(cardInput({ title: 'docker', body: 'b' }));
    expect(context.cards.getCard(created.id)?.createdAt).toBe('2024-05-06T07:08:09.000Z');
  });

  it('gives the HTTP app the card repository, the queue and the audit trail', async () => {
    const context = createRuntimeContext({ db: t.db });
    const createCard = vi.spyOn(context.cards, 'createCard');
    const enqueue = vi.spyOn(context.events, 'enqueue');
    const append = vi.spyOn(context.activity, 'append');

    const app = createApp({
      context,
      token: TOKEN,
      version: '1.2.3-test',
      pid: 4242,
      startedAt: Date.now(),
      requestShutdown: () => {},
    });
    const response = await app.request(
      '/api/cards',
      {
        method: 'POST',
        headers: {
          host: '127.0.0.1:7800',
          'content-type': 'application/json',
          'x-memhub-token': TOKEN,
        },
        body: JSON.stringify({ title: 'shared', body: 'one graph', type: 'fact' }),
      },
      LOCAL_ENV
    );

    expect(response.status).toBe(202);
    expect(createCard).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith('card.created', { card_id: 1 });
    expect(append).toHaveBeenCalledWith('hook', 'card.created', 1, expect.anything());
  });

  it('gives the indexing worker the card repository of the context', async () => {
    const context = createRuntimeContext({ db: t.db });
    context.cards.createCard(cardInput({ title: 'shared', body: 'one graph' }));

    const worker = new IndexingWorker({
      db: t.db,
      embedder: new FakeEmbedder(),
      vectors: new FakeVectorStore(),
      repositories: context,
    });
    const getCard = vi.spyOn(context.cards, 'getCard');
    const setIndexedAt = vi.spyOn(context.cards, 'setIndexedAt');
    const setLastEventId = vi.spyOn(context.workerState, 'setLastEventId');

    const processed = await worker.tick();

    expect(processed).toBe(1);
    expect(getCard).toHaveBeenCalledWith(1);
    expect(setIndexedAt).toHaveBeenCalled();
    expect(setLastEventId).toHaveBeenCalledWith(1);
  });

  it('gives the job timers the event queue of the context', () => {
    vi.useFakeTimers();
    try {
      const context = createRuntimeContext({ db: t.db });
      const enqueue = vi.spyOn(context.events, 'enqueue');
      const timers = new JobTimers(context, { compensationIntervalMs: 100 });
      timers.start();
      vi.advanceTimersByTime(100);
      expect(enqueue).toHaveBeenCalledWith('job.compensation_scan', {});
      timers.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives the search service the semantic backend of the context', async () => {
    const context = createRuntimeContext({
      db: t.db,
      embedder: new FakeEmbedder(),
      vectors: new FakeVectorStore(),
    });
    const semantic = context.semantic as SemanticSearch;
    semantic.setReady(true);
    const search = vi.spyOn(semantic, 'search');

    const outcome = await context.search.search('docker', 'semantic', 10);

    expect(outcome.modeUsed).toBe('semantic');
    expect(search).toHaveBeenCalledWith('docker', 10);
  });

  it('satisfies the repository bundle of the worker layer', () => {
    // The context satisfies WorkerRepositories, so the daemon hands it
    // over as-is (this is what start.ts does) - no second store graph.
    const context: RuntimeContext = createRuntimeContext({ db: t.db });
    const repositories: WorkerRepositories = context;
    expect(repositories.cards).toBe(context.cards);
    expect(repositories.events).toBe(context.events);
    expect(repositories.activity).toBe(context.activity);
    expect(repositories.workerState).toBe(context.workerState);
    expect(repositories.transactions).toBe(context.transactions);
  });
});

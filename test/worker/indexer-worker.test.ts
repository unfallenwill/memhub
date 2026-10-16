import { describe, expect, it } from 'vitest';
import { WorkerStateStore, WORKER_STATE_KEYS } from '../../src/db/worker-state.js';
import { cardEmbeddingText } from '../../src/worker/rebuild.js';
import { IndexingWorker } from '../../src/worker/indexer-worker.js';
import {
  cardInput,
  createTestDb,
  deterministicVector,
  FakeEmbedder,
  FakeVectorStore,
} from '../test-utils.js';

describe('IndexingWorker', () => {
  function setup(options: { failFor?: (text: string) => boolean; embedBatchSize?: number } = {}) {
    const t = createTestDb();
    const embedder = new FakeEmbedder({ failFor: options.failFor });
    const vectors = new FakeVectorStore();
    const worker = new IndexingWorker({
      db: t.db,
      embedder,
      vectors,
      embedBatchSize: options.embedBatchSize,
    });
    return { t, embedder, vectors, worker };
  }

  it('consumes card.created events: vector stored, indexed_at backfilled, activity logged', async () => {
    const { t, vectors, worker } = setup();
    try {
      t.cards.createCard(cardInput({ title: 'First', body: 'Body one' }));
      expect(t.cards.getCard(1)?.indexedAt).toBeNull();

      expect(await worker.tick()).toBe(1);

      const card = t.cards.getCard(1);
      expect(card?.indexedAt).not.toBeNull();
      expect(vectors.vectors.has(1)).toBe(true);

      const events = t.events.listAll();
      expect(events[0].processedAt).not.toBeNull();
      expect(events[0].error).toBeNull();

      const activity = t.activity.list(null, 10);
      const workerEntry = activity.entries.find(e => e.actor === 'worker');
      expect(workerEntry?.action).toBe('card.indexed');
      expect(workerEntry?.cardId).toBe(1);
      expect(workerEntry?.detail).toMatchObject({ model: 'fake-embedding-model', via: 'event' });

      expect(worker.offset).toBe(events[0].id);
    } finally {
      t.close();
    }
  });

  it('embeds burst writes in batches', async () => {
    const { t, embedder, worker } = setup();
    try {
      for (const title of ['a', 'b', 'c']) {
        t.cards.createCard(cardInput({ title, body: `body ${title}` }));
      }
      await worker.tick();
      expect(embedder.embedCalls).toHaveLength(1);
      expect(embedder.embedCalls[0]).toHaveLength(3);
      expect(embedder.embedCalls[0][0]).toBe(cardEmbeddingText(t.cards.getCard(1)!));
    } finally {
      t.close();
    }
  });

  it('does not reprocess consumed events when restarted on the same database', async () => {
    const t = createTestDb();
    const embedder = new FakeEmbedder();
    const vectors = new FakeVectorStore();
    try {
      t.cards.createCard(cardInput({ title: 'One', body: 'b1' }));
      const worker1 = new IndexingWorker({ db: t.db, embedder, vectors });
      await worker1.tick();
      expect(embedder.embedCalls).toHaveLength(1);

      // A brand new card arrives; a restarted worker must only process it.
      t.cards.createCard(cardInput({ title: 'Two', body: 'b2' }));
      const worker2 = new IndexingWorker({ db: t.db, embedder, vectors });
      await worker2.tick();

      expect(embedder.embedCalls).toHaveLength(2);
      expect(embedder.embedCalls[1]).toHaveLength(1);
      expect(embedder.embedCalls[1][0]).toBe(cardEmbeddingText(t.cards.getCard(2)!));
      expect(t.events.listAll().every(e => e.processedAt !== null)).toBe(true);
      // The first card was not re-embedded: still exactly one vector write.
      expect(vectors.upserts.filter(u => u.cardId === 1)).toHaveLength(1);
    } finally {
      t.close();
    }
  });

  it('skips a failing card, records events.error and advances the offset', async () => {
    const { t, embedder, worker } = setup({
      failFor: text => text.includes('POISON'),
      embedBatchSize: 1,
    });
    try {
      t.cards.createCard(cardInput({ title: 'Good', body: 'fine' }));
      t.cards.createCard(cardInput({ title: 'Bad', body: 'POISON' }));
      t.cards.createCard(cardInput({ title: 'Also good', body: 'fine too' }));

      expect(await worker.tick()).toBe(3);

      const good = t.cards.getCard(1);
      const bad = t.cards.getCard(2);
      const third = t.cards.getCard(3);
      expect(good?.indexedAt).not.toBeNull();
      expect(bad?.indexedAt).toBeNull();
      expect(third?.indexedAt).not.toBeNull();

      const events = t.events.listAll();
      expect(events).toHaveLength(3);
      expect(events.every(e => e.processedAt !== null)).toBe(true);
      const failed = events.find(e => JSON.parse(e.payload).card_id === 2);
      expect(failed?.error).toContain('embedding failed');
      expect(events.filter(e => e.error === null)).toHaveLength(2);

      // Offset advanced past the failure; the next tick is a no-op.
      expect(await worker.tick()).toBe(0);
      expect(worker.offset).toBe(events[events.length - 1].id);
      expect(embedder.embedCalls.length).toBe(3);
    } finally {
      t.close();
    }
  });

  it('re-indexes updated cards (card.updated events)', async () => {
    const t = createTestDb();
    const embedder = new FakeEmbedder();
    const vectors = new FakeVectorStore();
    const worker = new IndexingWorker({ db: t.db, embedder, vectors });
    try {
      t.cards.createCard(cardInput({ title: 'T', body: 'B' }));
      await worker.tick();
      expect(vectors.upserts).toHaveLength(1);

      t.cards.updateCard(1, { body: 'new body' });
      await worker.tick();

      expect(vectors.upserts.filter(u => u.cardId === 1)).toHaveLength(2);
      expect(t.cards.getCard(1)?.indexedAt).not.toBeNull();
      expect(
        t.events
          .listAll()
          .filter(e => e.type === 'card.updated')
          .every(e => e.error === null)
      ).toBe(true);
    } finally {
      t.close();
    }
  });

  it('marks events for non-active cards processed without indexing', async () => {
    const { t, vectors, worker } = setup();
    try {
      t.cards.createCard(cardInput({ title: 'T', body: 'B' }));
      t.cards.archiveCard(1);
      await worker.tick();

      expect(vectors.upserts).toHaveLength(0);
      expect(t.cards.getCard(1)?.indexedAt).toBeNull();
      const events = t.events.listAll();
      expect(events.every(e => e.processedAt !== null && e.error === null)).toBe(true);
    } finally {
      t.close();
    }
  });

  it('records an error for unknown event types and advances', async () => {
    const { t, worker } = setup();
    try {
      t.events.enqueue('something.unknown', { nope: true });
      expect(await worker.tick()).toBe(1);
      const events = t.events.listAll();
      expect(events[0].processedAt).not.toBeNull();
      expect(events[0].error).toContain('unknown event type');
      expect(worker.offset).toBe(events[0].id);
    } finally {
      t.close();
    }
  });

  it('compensation scan indexes active cards that have no pending event', async () => {
    const { t, vectors, worker } = setup();
    try {
      t.cards.createCard(cardInput({ title: 'T', body: 'B' }));
      await worker.tick();

      // Simulate a lost index update: the card is unindexed but its
      // card.created event was already consumed.
      t.db.prepare('UPDATE cards SET indexed_at = NULL WHERE id = 1').run();
      t.events.enqueue('job.compensation_scan', {});
      await worker.tick();

      expect(t.cards.getCard(1)?.indexedAt).not.toBeNull();
      expect(vectors.upserts.filter(u => u.cardId === 1)).toHaveLength(2);
      const activity = t.activity.list(null, 50);
      expect(
        activity.entries.some(
          e => e.actor === 'worker' && e.cardId === 1 && e.detail?.via === 'compensation'
        )
      ).toBe(true);
    } finally {
      t.close();
    }
  });

  it('retention cleanup runs when the job event is consumed', async () => {
    const { t, worker } = setup();
    try {
      t.cards.createCard(cardInput({ title: 'T', body: 'B' }));
      await worker.tick();

      // Old processed event below the offset: deletable.
      t.events.enqueue('card.created', { card_id: 1 });
      t.db
        .prepare(
          "UPDATE events SET processed_at = '2020-01-01T00:00:00Z', created_at = '2020-01-01T00:00:00Z' WHERE id = 2"
        )
        .run();

      t.events.enqueue('job.retention_cleanup', {});
      await worker.tick();

      const events = t.events.listAll();
      expect(events.find(e => e.id === 2)).toBeUndefined(); // deleted
      expect(events.find(e => e.id === 1)?.processedAt).not.toBeNull(); // kept (pending before)
      expect(events.find(e => e.id === 3)?.type).toBe('job.retention_cleanup');
    } finally {
      t.close();
    }
  });

  it('start() with an unset model records the model without a rebuild', async () => {
    const t = createTestDb();
    const embedder = new FakeEmbedder();
    const vectors = new FakeVectorStore();
    const worker = new IndexingWorker({ db: t.db, embedder, vectors });
    try {
      t.cards.createCard(cardInput({ title: 'T', body: 'B' }));
      await worker.start();
      await worker.stop();

      const state = new WorkerStateStore(t.db);
      expect(state.getModel()).toBe('fake-embedding-model');
      expect(vectors.clearCount).toBe(0);
      // start() does not consume events; the loop does (may or may not have
      // run yet depending on timing) - drain explicitly.
      await worker.tick();
      expect(t.cards.getCard(1)?.indexedAt).not.toBeNull();
    } finally {
      t.close();
    }
  });

  it('start() with a changed model clears the vector store and rebuilds', async () => {
    const t = createTestDb();
    const embedder = new FakeEmbedder();
    const vectors = new FakeVectorStore();
    try {
      t.cards.createCard(cardInput({ title: 'T', body: 'B' }));
      // Simulate a previously indexed database built with another model.
      t.db.prepare('UPDATE cards SET indexed_at = ? WHERE id = 1').run('2024-01-01T00:00:00Z');
      await vectors.upsert(1, [0.1, 0.2]);
      const state = new WorkerStateStore(t.db);
      state.set(WORKER_STATE_KEYS.model, 'old-model');

      const worker = new IndexingWorker({ db: t.db, embedder, vectors });
      await worker.start();
      await worker.stop();

      expect(vectors.clearCount).toBe(1);
      expect(state.getModel()).toBe('fake-embedding-model');
      // The card was re-indexed from the SQLite source of truth with the
      // current model's embedding.
      const card = t.cards.getCard(1);
      expect(card).not.toBeNull();
      expect(vectors.vectors.get(1)).toEqual(deterministicVector(cardEmbeddingText(card!)));
      expect(card?.indexedAt).not.toBeNull();
      expect(card?.indexedAt).not.toBe('2024-01-01T00:00:00Z');
    } finally {
      t.close();
    }
  });

  it('start() with the same model does not rebuild', async () => {
    const t = createTestDb();
    const embedder = new FakeEmbedder();
    const vectors = new FakeVectorStore();
    try {
      const state = new WorkerStateStore(t.db);
      state.set(WORKER_STATE_KEYS.model, 'fake-embedding-model');
      t.cards.createCard(cardInput({ title: 'T', body: 'B' }));
      t.db.prepare('UPDATE cards SET indexed_at = ? WHERE id = 1').run('2024-01-01T00:00:00Z');

      const worker = new IndexingWorker({ db: t.db, embedder, vectors });
      await worker.start();
      await worker.stop();

      expect(vectors.clearCount).toBe(0);
      expect(vectors.upserts).toHaveLength(0);
    } finally {
      t.close();
    }
  });
});

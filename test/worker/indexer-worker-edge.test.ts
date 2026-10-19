/**
 * The failure paths of the indexing worker (src/worker/indexer-worker.ts).
 *
 * The worker must never lose an event: a card that vanished, a broken
 * event payload, a provider that answers with too few vectors and a
 * vector store that refuses the write are all recorded on the event
 * and the worker moves on.
 */

import { describe, expect, it, vi } from 'vitest';
import type { EmbeddingProvider } from '../../src/core/ports/embedding.js';
import { createDbContext } from '../../src/db/context.js';
import { IndexingWorker } from '../../src/worker/indexer-worker.js';
import { cardInput, createTestDb, FakeEmbedder, FakeVectorStore } from '../test-utils.js';

/** A provider that answers with fewer vectors than it was given texts. */
const shortEmbedder: EmbeddingProvider = {
  modelId: 'short-embedder',
  dimensions: 8,
  ensureLoaded: async () => {},
  embed: async () => [],
};

describe('the failure paths of the indexing worker', () => {
  it('records an event whose card does not exist', async () => {
    const t = createTestDb();
    try {
      const worker = new IndexingWorker({
        repositories: createDbContext(t.db),
        embedder: new FakeEmbedder(),
        vectors: new FakeVectorStore(),
      });
      t.events.enqueue('card.created', { card_id: 999 });

      expect(await worker.tick()).toBe(1);

      const event = t.events.listAll()[0];
      expect(event.processedAt).not.toBeNull();
      expect(event.error).toContain('card 999 not found');
    } finally {
      t.close();
    }
  });

  it('records an event with a broken payload', async () => {
    const t = createTestDb();
    try {
      const worker = new IndexingWorker({
        repositories: createDbContext(t.db),
        embedder: new FakeEmbedder(),
        vectors: new FakeVectorStore(),
      });
      t.db
        .prepare(
          "INSERT INTO events (type, payload, created_at) VALUES ('card.created', 'not json', '2024-01-01T00:00:00Z')"
        )
        .run();

      expect(await worker.tick()).toBe(1);

      const event = t.events.listAll()[0];
      expect(event.processedAt).not.toBeNull();
      expect(event.error).toContain('invalid event payload');
    } finally {
      t.close();
    }
  });

  it('records a card the provider did not answer with a vector', async () => {
    const t = createTestDb();
    try {
      const worker = new IndexingWorker({
        repositories: createDbContext(t.db),
        embedder: shortEmbedder,
        vectors: new FakeVectorStore(),
      });
      t.cards.createCard(cardInput({ title: 'T', body: 'B' }));

      expect(await worker.tick()).toBe(1);

      const event = t.events.listAll()[0];
      expect(event.error).toContain('embedding returned no vector');
      expect(t.cards.getCard(1)?.indexedAt).toBeNull();
    } finally {
      t.close();
    }
  });

  it('records an event whose payload holds no usable card id', async () => {
    const t = createTestDb();
    try {
      const worker = new IndexingWorker({
        repositories: createDbContext(t.db),
        embedder: new FakeEmbedder(),
        vectors: new FakeVectorStore(),
      });
      // Valid JSON, but the card id is not a positive integer.
      t.db
        .prepare(
          "INSERT INTO events (type, payload, created_at) VALUES ('card.created', ?, '2024-01-01T00:00:00Z')"
        )
        .run('{"card_id": "not a number"}');

      expect(await worker.tick()).toBe(1);

      const event = t.events.listAll()[0];
      expect(event.processedAt).not.toBeNull();
      expect(event.error).toContain('invalid event payload');
    } finally {
      t.close();
    }
  });

  it('records a card the vector store refused', async () => {
    const t = createTestDb();
    try {
      const worker = new IndexingWorker({
        repositories: createDbContext(t.db),
        embedder: new FakeEmbedder(),
        vectors: new FakeVectorStore({ failUpsertFor: () => true }),
      });
      t.cards.createCard(cardInput({ title: 'T', body: 'B' }));

      expect(await worker.tick()).toBe(1);

      const event = t.events.listAll()[0];
      expect(event.error).toContain('vector store failed');
      expect(t.cards.getCard(1)?.indexedAt).toBeNull();
    } finally {
      t.close();
    }
  });

  it('does not start after it was stopped', async () => {
    const t = createTestDb();
    try {
      const embedder = new FakeEmbedder();
      const worker = new IndexingWorker({
        repositories: createDbContext(t.db),
        embedder,
        vectors: new FakeVectorStore(),
      });
      await worker.stop();
      await worker.start();

      expect(embedder.embedCalls).toHaveLength(0);
      expect(await worker.tick()).toBe(0);
    } finally {
      t.close();
    }
  });

  it('keeps running when a tick fails unexpectedly', async () => {
    const t = createTestDb();
    try {
      const worker = new IndexingWorker({
        repositories: createDbContext(t.db),
        embedder: new FakeEmbedder(),
        vectors: new FakeVectorStore(),
        pollIntervalMs: 5,
      });
      const tick = vi.spyOn(worker, 'tick').mockRejectedValue(new Error('the database is busy'));
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

      await worker.start();
      await new Promise(resolve => setTimeout(resolve, 30));
      await worker.stop();

      expect(tick).toHaveBeenCalled();
      expect(logged.mock.calls.flat().join('\n')).toContain('indexing worker tick failed');
    } finally {
      t.close();
    }
  });
});

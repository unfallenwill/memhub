import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { ActivityLog } from '../../../src/db/activity.js';
import { CardStore } from '../../../src/db/cards.js';
import { withTransaction } from '../../../src/db/database.js';
import { DeviceTokenStore } from '../../../src/db/device-tokens.js';
import { EventStore } from '../../../src/db/events.js';
import { KeywordSearch } from '../../../src/db/search.js';
import { WorkerStateStore } from '../../../src/db/worker-state.js';
import { AdminPasswordStore } from '../../../src/db/admin-password.js';
import { SemanticSearch } from '../../../src/services/semantic-search.js';
import { LanceVectorIndex } from '../../../src/storage/vector-index.js';
import { systemClock } from '../../../src/core/ports/clock.js';
import type { EmbeddingProvider } from '../../../src/core/ports/embedding.js';
import type {
  ActivityRepository,
  AdminPasswordRepository,
  CardRepository,
  DeviceTokenRepository,
  EventRepository,
  WorkerStateRepository,
} from '../../../src/core/ports/repositories.js';
import type {
  KeywordSearchBackend,
  SemanticSearchBackend,
} from '../../../src/core/ports/search.js';
import type { TransactionRunner } from '../../../src/core/ports/transaction.js';
import type { VectorStore } from '../../../src/core/ports/vector.js';
import { createTestDb, FakeEmbedder, FakeVectorStore } from '../../test-utils.js';

/**
 * The port interfaces must mirror the public surface of the existing
 * adapters one-to-one. The typed assignments below fail to compile when a
 * store drifts away from its port; the runtime assertions make the same
 * contract visible in the test report.
 */
describe('port conformance', () => {
  it('CardStore satisfies CardRepository', () => {
    const t = createTestDb();
    try {
      const cards: CardRepository = new CardStore(t.db, {
        events: new EventStore(t.db),
        activity: new ActivityLog(t.db),
      });
      expect(typeof cards.createCard).toBe('function');
      expect(typeof cards.getCard).toBe('function');
      expect(typeof cards.listCards).toBe('function');
      expect(typeof cards.updateCard).toBe('function');
      expect(typeof cards.archiveCard).toBe('function');
      expect(typeof cards.invalidateCard).toBe('function');
      expect(typeof cards.recordAccess).toBe('function');
      expect(typeof cards.listActiveUnindexed).toBe('function');
      expect(typeof cards.listActiveIds).toBe('function');
      expect(typeof cards.resetActiveIndexedAt).toBe('function');
      expect(typeof cards.setIndexedAt).toBe('function');
      expect(typeof cards.stats).toBe('function');
      expect(cards.stats().total).toBe(0);
    } finally {
      t.close();
    }
  });

  it('EventStore satisfies EventRepository', () => {
    const t = createTestDb();
    try {
      const events: EventRepository = new EventStore(t.db);
      expect(typeof events.enqueue).toBe('function');
      expect(typeof events.stats).toBe('function');
      expect(typeof events.listBatchAfter).toBe('function');
      expect(typeof events.markProcessed).toBe('function');
      expect(typeof events.listAll).toBe('function');
      expect(events.stats().pendingEvents).toBe(0);
    } finally {
      t.close();
    }
  });

  it('ActivityLog satisfies ActivityRepository', () => {
    const t = createTestDb();
    try {
      const activity: ActivityRepository = new ActivityLog(t.db);
      expect(typeof activity.append).toBe('function');
      expect(typeof activity.list).toBe('function');
      expect(activity.list(null, 10).entries).toEqual([]);
    } finally {
      t.close();
    }
  });

  it('DeviceTokenStore satisfies DeviceTokenRepository', () => {
    const t = createTestDb();
    try {
      const tokens: DeviceTokenRepository = new DeviceTokenStore(t.db);
      expect(typeof tokens.create).toBe('function');
      expect(typeof tokens.findActiveByHash).toBe('function');
      expect(typeof tokens.list).toBe('function');
      expect(typeof tokens.touchLastUsed).toBe('function');
      expect(typeof tokens.revoke).toBe('function');
      expect(typeof tokens.revokeAll).toBe('function');
      expect(tokens.list()).toEqual([]);
    } finally {
      t.close();
    }
  });

  it('WorkerStateStore satisfies WorkerStateRepository', () => {
    const t = createTestDb();
    try {
      const state: WorkerStateRepository = new WorkerStateStore(t.db);
      expect(typeof state.get).toBe('function');
      expect(typeof state.set).toBe('function');
      expect(typeof state.getModel).toBe('function');
      expect(typeof state.setModel).toBe('function');
      expect(typeof state.getLastEventId).toBe('function');
      expect(typeof state.setLastEventId).toBe('function');
      expect(state.getLastEventId()).toBe(0);
    } finally {
      t.close();
    }
  });

  it('AdminPasswordStore satisfies AdminPasswordRepository', () => {
    const t = createTestDb();
    try {
      const admin: AdminPasswordRepository = new AdminPasswordStore(t.db);
      expect(typeof admin.get).toBe('function');
      expect(typeof admin.set).toBe('function');
      expect(typeof admin.clear).toBe('function');
      expect(admin.get()).toBeNull();
    } finally {
      t.close();
    }
  });

  it('KeywordSearch satisfies KeywordSearchBackend', () => {
    const t = createTestDb();
    try {
      const keyword: KeywordSearchBackend = new KeywordSearch(
        t.db,
        new CardStore(t.db, {
          events: new EventStore(t.db),
          activity: new ActivityLog(t.db),
        })
      );
      expect(typeof keyword.search).toBe('function');
      expect(typeof keyword.searchUnindexed).toBe('function');
      expect(keyword.search('anything', 5)).toEqual([]);
    } finally {
      t.close();
    }
  });

  it('SemanticSearch satisfies SemanticSearchBackend', () => {
    const t = createTestDb();
    try {
      const semantic: SemanticSearchBackend = new SemanticSearch({
        embedder: new FakeEmbedder(),
        vectors: new FakeVectorStore(),
        cards: t.cards,
      });
      expect(semantic.ready).toBe(false);
      expect(semantic.notInstalled).toBe(false);
      expect(typeof semantic.search).toBe('function');
    } finally {
      t.close();
    }
  });

  it('the embedder and vector store satisfy their ports', () => {
    const embedder: EmbeddingProvider = new FakeEmbedder();
    expect(embedder.dimensions).toBe(8);
    expect(typeof embedder.ensureLoaded).toBe('function');
    expect(typeof embedder.embed).toBe('function');

    const vectors: VectorStore = new FakeVectorStore();
    expect(typeof vectors.initialize).toBe('function');
    expect(typeof vectors.upsert).toBe('function');
    expect(typeof vectors.clear).toBe('function');
    expect(typeof vectors.searchByVector).toBe('function');

    // Constructing LanceVectorIndex does not touch the filesystem; only
    // initialize() would open the database.
    const lance: VectorStore = new LanceVectorIndex(join(tmpdir(), 'memhub-conformance'));
    expect(typeof lance.initialize).toBe('function');
    expect(typeof lance.upsert).toBe('function');
    expect(typeof lance.clear).toBe('function');
    expect(typeof lance.searchByVector).toBe('function');
  });

  it('systemClock satisfies the Clock port and withTransaction a TransactionRunner', () => {
    const t = createTestDb();
    try {
      expect(typeof systemClock.now()).toBe('number');
      expect(typeof systemClock.isoNow()).toBe('string');

      const runner: TransactionRunner = {
        transaction: <T>(fn: () => T): T => withTransaction(t.db, fn),
      };
      expect(runner.transaction(() => 42)).toBe(42);
    } finally {
      t.close();
    }
  });
});

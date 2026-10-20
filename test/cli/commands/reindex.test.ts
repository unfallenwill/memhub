import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../../../src/db/database.js';
import { CardStore } from '../../../src/db/cards.js';
import { EventStore } from '../../../src/db/events.js';
import { ActivityLog } from '../../../src/db/activity.js';
import { WorkerStateStore } from '../../../src/db/worker-state.js';
import { runReindexCommand } from '../../../src/cli/commands/reindex.js';
import { cardInput, FakeEmbedder, FakeVectorStore, moduleNotFoundError } from '../../test-utils.js';

/**
 * A temporary MemHub home with a database. Unlike createTestDb, closing
 * only releases the database handle; the directory is removed separately
 * (the reindex command must be able to reopen the database afterwards).
 */
function createDbHome(): {
  home: string;
  cards: CardStore;
  closeDb(): void;
  cleanup(): void;
} {
  const home = mkdtempSync(join(tmpdir(), 'memhub-reindex-'));
  const db = openDatabase(join(home, 'memhub.db'));
  const cards = new CardStore(db, {
    events: new EventStore(db),
    activity: new ActivityLog(db),
  });
  return {
    home,
    cards,
    closeDb: () => {
      db.close();
    },
    cleanup: () => {
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

function openDb(home: string) {
  return openDatabase(join(home, 'memhub.db'));
}

function openCards(db: ReturnType<typeof openDb>): CardStore {
  return new CardStore(db, { events: new EventStore(db), activity: new ActivityLog(db) });
}

describe('runReindexCommand', () => {
  it('rebuilds the vector index from SQLite and records the model', async () => {
    const t = createDbHome();
    try {
      t.cards.createCard(cardInput({ title: 'One', body: 'b1' }));
      t.cards.createCard(cardInput({ title: 'Two', body: 'b2' }));
      t.closeDb();

      const vectors = new FakeVectorStore();
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const code = await runReindexCommand({
          home: t.home,
          vectors,
          embedder: new FakeEmbedder(),
        });
        expect(code).toBe(0);
        expect(vectors.upserts.map(u => u.cardId)).toEqual([1, 2]);

        const db = openDb(t.home);
        try {
          const cards = openCards(db);
          expect(cards.getCard(1)?.indexedAt).not.toBeNull();
          expect(cards.getCard(2)?.indexedAt).not.toBeNull();
          expect(new WorkerStateStore(db).getModel()).toBe('fake-embedding-model');
        } finally {
          db.close();
        }
      } finally {
        log.mockRestore();
      }
    } finally {
      t.cleanup();
    }
  });

  it('reports failures without aborting the whole rebuild', async () => {
    const t = createDbHome();
    try {
      t.cards.createCard(cardInput({ title: 'Good', body: 'fine' }));
      t.cards.createCard(cardInput({ title: 'Bad', body: 'also fine' }));
      t.closeDb();

      const vectors = new FakeVectorStore({ failUpsertFor: id => id === 2 });
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const code = await runReindexCommand({
          home: t.home,
          vectors,
          embedder: new FakeEmbedder(),
        });
        expect(code).toBe(1);
        expect(vectors.upserts.map(u => u.cardId)).toEqual([1]);

        const db = openDb(t.home);
        try {
          const cards = openCards(db);
          expect(cards.getCard(1)?.indexedAt).not.toBeNull();
          expect(cards.getCard(2)?.indexedAt).toBeNull();
        } finally {
          db.close();
        }
      } finally {
        error.mockRestore();
        log.mockRestore();
      }
    } finally {
      t.cleanup();
    }
  });

  it('fails cleanly when no database exists', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'memhub-empty-'));
    try {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const code = await runReindexCommand({ home: empty });
        expect(code).toBe(1);
        expect(error).toHaveBeenCalledTimes(1);
      } finally {
        error.mockRestore();
        log.mockRestore();
      }
    } finally {
      rmSync(empty, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it('explains how to install the semantic stack when it is missing', async () => {
    const t = createDbHome();
    try {
      t.cards.createCard(cardInput({ title: 'One', body: 'b1' }));
      t.closeDb();

      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const code = await runReindexCommand({
          home: t.home,
          vectors: new FakeVectorStore(),
          embedder: new FakeEmbedder({
            failLoad: true,
            failLoadWith: moduleNotFoundError('@huggingface/transformers'),
          }),
        });
        expect(code).toBe(1);
        const messages = error.mock.calls.map(call => call.join(' ')).join('\n');
        expect(messages).toContain('the semantic stack is not installed');
        expect(messages).toContain('npm install @huggingface/transformers @lancedb/lancedb');
      } finally {
        error.mockRestore();
        log.mockRestore();
      }
    } finally {
      t.cleanup();
    }
  });
});

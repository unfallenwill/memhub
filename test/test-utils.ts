/**
 * Shared test fixtures.
 *
 * Every test uses a throwaway temporary directory so nothing ever touches
 * the real ~/.memhub.
 */

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { DatabaseSync } from 'node:sqlite';
import { getTransactionRunner, openDatabase } from '../src/db/database.js';
import { CardStore } from '../src/db/cards.js';
import { EventStore } from '../src/db/events.js';
import { ActivityLog } from '../src/db/activity.js';
import { KeywordSearch } from '../src/db/keyword-search.js';
import { systemClock, type Clock } from '../src/core/ports/clock.js';
import type { TransactionRunner } from '../src/core/ports/transaction.js';
import type { EmbeddingProvider } from '../src/embedding/embedder.js';
import type { CardVectorStore, VectorMatch } from '../src/storage/vector-index.js';
import type { CreateCardInput } from '../src/db/types.js';

/** A freshly migrated database in a temporary directory. */
export interface TestDb {
  readonly db: DatabaseSync;
  readonly home: string;
  readonly cards: CardStore;
  readonly events: EventStore;
  readonly activity: ActivityLog;
  readonly search: KeywordSearch;
  /** The clock every store of this database reads its time from. */
  readonly clock: Clock;
  /** The transaction runner every store of this database uses. */
  readonly transactions: TransactionRunner;
  close(): void;
}

/** Options for createTestDb. */
export interface TestDbOptions {
  /** Clock handed to every store. Defaults to the system clock. */
  readonly clock?: Clock | undefined;
  /** Transaction runner handed to every store. Defaults to the db runner. */
  readonly transactions?: TransactionRunner | undefined;
}

/** Create an isolated database with all stores wired up. */
export function createTestDb(options: TestDbOptions = {}): TestDb {
  const home = mkdtempSync(join(tmpdir(), 'memhub-test-'));
  const db = openDatabase(join(home, 'memhub.db'));
  const clock = options.clock ?? systemClock;
  const transactions = options.transactions ?? getTransactionRunner(db);
  const events = new EventStore(db, clock);
  const activity = new ActivityLog(db, clock);
  const cards = new CardStore(db, { events, activity, clock, transactions });
  const search = new KeywordSearch(db, cards);
  return {
    db,
    home,
    cards,
    events,
    activity,
    search,
    clock,
    transactions,
    close: () => {
      db.close();
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

/**
 * A clock whose time is fully controlled by the test.
 *
 * Timestamps are frozen, so assertions about created_at/updated_at are
 * deterministic; advance() moves time forward explicitly.
 */
export class MutableClock implements Clock {
  private current: number;

  constructor(current: string | number = '2024-01-01T00:00:00.000Z') {
    this.current = typeof current === 'number' ? current : Date.parse(current);
  }

  now(): number {
    return this.current;
  }

  isoNow(): string {
    return new Date(this.current).toISOString();
  }

  /** Move the clock to an absolute ISO timestamp. */
  set(iso: string): void {
    this.current = Date.parse(iso);
  }

  /** Move the clock forward by the given number of milliseconds. */
  advance(ms: number): void {
    this.current += ms;
  }
}

/** Convenience input for card creation with defaults filled in. */
export function cardInput(overrides: Partial<CreateCardInput> = {}): CreateCardInput {
  return {
    title: 'Default title',
    body: 'Default body',
    type: 'fact',
    cues: [],
    confidence: 0.5,
    ...overrides,
  };
}

/**
 * Deterministic text -> vector mapping used by the fake embedder.
 * Same text always yields the same normalized vector; different texts
 * yield different vectors with high probability.
 */
export function deterministicVector(text: string, dim = 8): number[] {
  const vector = new Array<number>(dim).fill(0.1);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
    vector[i % dim] += (hash % 997) / 997;
  }
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vector.map(v => v / norm);
}

/** An error shaped like Node's dynamic-import failure for a missing package. */
export function moduleNotFoundError(pkg: string): Error {
  const error = new Error(`Cannot find package '${pkg}' imported from /memhub/dist/src/x.js`);
  (error as NodeJS.ErrnoException).code = 'ERR_MODULE_NOT_FOUND';
  return error;
}

/** Options for FakeEmbedder. */
export interface FakeEmbedderOptions {
  readonly modelId?: string | undefined;
  /** When set, embed() rejects for batches containing a matching text. */
  readonly failFor?: ((text: string) => boolean) | undefined;
  /** When true, ensureLoaded() always rejects. */
  readonly failLoad?: boolean | undefined;
  /** Error thrown by ensureLoaded() when failLoad is set. */
  readonly failLoadWith?: unknown;
}

/** In-memory EmbeddingProvider for tests (never downloads a model). */
export class FakeEmbedder implements EmbeddingProvider {
  readonly modelId: string;
  /** Matches the dimensionality produced by deterministicVector(). */
  readonly dimensions = 8;
  /** Every embed() call, for asserting batching behaviour. */
  readonly embedCalls: readonly string[][];
  ensureLoadedCalls = 0;

  constructor(private readonly options: FakeEmbedderOptions = {}) {
    this.modelId = options.modelId ?? 'fake-embedding-model';
    this.embedCalls = [];
  }

  async ensureLoaded(): Promise<void> {
    this.ensureLoadedCalls++;
    if (this.options.failLoad) {
      throw this.options.failLoadWith ?? new Error('model load failed');
    }
  }

  async embed(texts: readonly string[]): Promise<readonly number[][]> {
    const batch = [...texts];
    (this.embedCalls as string[][]).push(batch);
    for (const text of batch) {
      if (this.options.failFor?.(text)) {
        throw new Error(`embedding failed for: ${text}`);
      }
    }
    return batch.map(text => deterministicVector(text));
  }
}

/** Options for FakeVectorStore. */
export interface FakeVectorStoreOptions {
  /** When set, upsert() rejects for matching card ids (per-card failure). */
  readonly failUpsertFor?: ((cardId: number) => boolean) | undefined;
}

/** In-memory CardVectorStore for tests. */
export class FakeVectorStore implements CardVectorStore {
  readonly vectors = new Map<number, number[]>();
  readonly upserts: { cardId: number; vector: number[] }[] = [];
  clearCount = 0;

  constructor(private readonly options: FakeVectorStoreOptions = {}) {}

  async initialize(): Promise<void> {}

  async upsert(cardId: number, vector: readonly number[]): Promise<void> {
    if (this.options.failUpsertFor?.(cardId)) {
      throw new Error(`vector store failed for card ${cardId}`);
    }
    const copy = [...vector];
    this.vectors.set(cardId, copy);
    this.upserts.push({ cardId, vector: copy });
  }

  async clear(): Promise<void> {
    this.clearCount++;
    this.vectors.clear();
  }

  async searchByVector(vector: readonly number[], limit: number): Promise<readonly VectorMatch[]> {
    const query = [...vector];
    const matches: VectorMatch[] = [];
    for (const [cardId, stored] of this.vectors) {
      let sum = 0;
      for (let i = 0; i < query.length; i++) {
        const diff = query[i] - (stored[i] ?? 0);
        sum += diff * diff;
      }
      matches.push({ cardId, distance: Math.sqrt(sum) });
    }
    return matches.sort((a, b) => a.distance - b.distance).slice(0, limit);
  }
}

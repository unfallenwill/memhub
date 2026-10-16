/**
 * Vector store for card embeddings.
 *
 * SQLite is the single source of truth for cards; this LanceDB table is a
 * derived index that can be rebuilt at any time (`memhub reindex`, or the
 * automatic rebuild when the embedding model changes). Writes are
 * delete+insert per card_id, which makes re-indexing idempotent.
 */

import * as lancedb from '@lancedb/lancedb';

/** Name of the LanceDB table holding card vectors. */
export const CARD_VECTORS_TABLE = 'card_vectors';

/** A nearest-neighbour match from the vector index. */
export interface VectorMatch {
  readonly cardId: number;
  /** Vector distance (lower = more similar). */
  readonly distance: number;
}

/**
 * The vector store contract. Implemented by LanceVectorIndex in
 * production and by in-memory fakes in tests.
 */
export interface CardVectorStore {
  /** Connect and prepare the table (idempotent). */
  initialize(): Promise<void>;
  /** Store a card vector, replacing any previous vector for the card. */
  upsert(cardId: number, vector: readonly number[]): Promise<void>;
  /** Drop all stored vectors (used by full rebuilds). */
  clear(): Promise<void>;
  /** Find the `limit` nearest cards to a query vector. */
  searchByVector(vector: readonly number[], limit: number): Promise<readonly VectorMatch[]>;
}

interface StoredRow {
  readonly card_id: number;
  readonly vector: number[];
  [key: string]: unknown;
}

interface QueryRow {
  readonly card_id: unknown;
  readonly _distance: unknown;
}

/**
 * LanceDB-backed vector store. One instance per open daemon.
 * The table is created lazily on the first upsert so an empty store
 * never needs a dummy row.
 */
export class LanceVectorIndex implements CardVectorStore {
  private connection: lancedb.Connection | null = null;
  private table: lancedb.Table | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(private readonly dbPath: string) {}

  async initialize(): Promise<void> {
    if (this.initPromise === null) {
      // Do not cache a rejected promise: a transient failure (e.g. an
      // antivirus lock on a fresh directory) must not disable the store
      // for the whole process lifetime.
      this.initPromise = this.connect().catch(error => {
        this.initPromise = null;
        throw error;
      });
    }
    await this.initPromise;
  }

  async upsert(cardId: number, vector: readonly number[]): Promise<void> {
    await this.initialize();
    const connection = this.connection;
    if (connection === null) {
      throw new Error('vector store is not initialized');
    }
    const row: StoredRow = { card_id: cardId, vector: [...vector] };
    if (this.table === null) {
      // First write establishes the table schema with a real row.
      this.table = await connection.createTable(CARD_VECTORS_TABLE, [row]);
      return;
    }
    // Idempotent write: remove any previous vector for this card first.
    await this.table.delete(`card_id = ${cardId}`);
    await this.table.add([row]);
  }

  async clear(): Promise<void> {
    await this.initialize();
    if (this.connection !== null && this.table !== null) {
      await this.connection.dropTable(CARD_VECTORS_TABLE);
      this.table = null;
    }
  }

  async searchByVector(vector: readonly number[], limit: number): Promise<readonly VectorMatch[]> {
    if (limit <= 0) return [];
    await this.initialize();
    const table = this.table;
    if (table === null) return [];
    const rows = (await table
      .search([...vector])
      .limit(limit)
      .toArray()) as unknown[];
    return rows.flatMap(row => {
      const candidate = row as QueryRow;
      const cardId = Number(candidate.card_id);
      const distance = Number(candidate._distance);
      if (!Number.isInteger(cardId) || !Number.isFinite(distance)) return [];
      return [{ cardId, distance }];
    });
  }

  private async connect(): Promise<void> {
    this.connection = await lancedb.connect(this.dbPath);
    const names = await this.connection.tableNames();
    if (names.includes(CARD_VECTORS_TABLE)) {
      this.table = await this.connection.openTable(CARD_VECTORS_TABLE);
    }
  }
}

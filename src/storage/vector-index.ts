/**
 * Vector store for card embeddings.
 *
 * SQLite is the single source of truth for cards; this LanceDB table is a
 * derived index that can be rebuilt at any time (`memhub reindex`, or the
 * automatic rebuild when the embedding model changes). Writes are
 * delete+insert per card_id, which makes re-indexing idempotent.
 *
 * @lancedb/lancedb is an optional peer dependency and is imported lazily
 * inside connect(), so this module (and everything that imports it, which
 * includes the whole CLI) loads even when the package is not installed.
 */

import type * as lancedb from '@lancedb/lancedb';
import type { VectorMatch, VectorStore } from '../core/ports/vector.js';

// The vector store contract now lives in the pure port layer
// (src/core/ports/vector.ts). CardVectorStore is kept as a deprecated
// alias for backwards compatibility.
export type {
  VectorMatch,
  VectorStore,
  VectorStore as CardVectorStore,
} from '../core/ports/vector.js';

/** Name of the LanceDB table holding card vectors. */
export const CARD_VECTORS_TABLE = 'card_vectors';

/** Options for LanceVectorIndex. */
export interface LanceVectorIndexOptions {
  /**
   * Expected vector dimensionality. When set, upsert() rejects vectors
   * whose length does not match, so that switching the embedding
   * provider cannot silently corrupt the LanceDB table schema. When it
   * is not set no validation happens (backwards compatible).
   */
  readonly dimensions?: number | undefined;
}

/** Thrown when a vector does not match the configured dimensionality. */
export class VectorDimensionMismatchError extends Error {
  constructor(
    /** The dimensionality the store was configured with. */
    readonly expected: number,
    /** The dimensionality of the rejected vector. */
    readonly actual: number
  ) {
    super(`vector dimension mismatch: expected ${expected}, got ${actual}`);
    this.name = 'VectorDimensionMismatchError';
  }
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
export class LanceVectorIndex implements VectorStore {
  private connection: lancedb.Connection | null = null;
  private table: lancedb.Table | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(
    private readonly dbPath: string,
    private readonly options: LanceVectorIndexOptions = {}
  ) {}

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
    // Validate before touching the store: a mismatching vector would
    // break the table schema, so it must never reach LanceDB.
    this.assertDimensions(vector);
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

  /** Reject vectors whose length differs from the configured dimensions. */
  private assertDimensions(vector: readonly number[]): void {
    const expected = this.options.dimensions;
    if (expected === undefined) return;
    if (vector.length !== expected) {
      throw new VectorDimensionMismatchError(expected, vector.length);
    }
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
    const lancedbModule = await import('@lancedb/lancedb');
    this.connection = await lancedbModule.connect(this.dbPath);
    const names = await this.connection.tableNames();
    if (names.includes(CARD_VECTORS_TABLE)) {
      this.table = await this.connection.openTable(CARD_VECTORS_TABLE);
    }
  }
}

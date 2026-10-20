/**
 * Vector store port.
 *
 * The vector index is a derived artifact: it can be rebuilt from SQLite at
 * any time. The production implementation lives in src/storage
 * (LanceVectorIndex); tests use in-memory fakes.
 */

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
export interface VectorStore {
  /** Connect and prepare the table (idempotent). */
  initialize(): Promise<void>;
  /** Store a card vector, replacing any previous vector for the card. */
  upsert(cardId: number, vector: readonly number[]): Promise<void>;
  /** Drop all stored vectors (used by full rebuilds). */
  clear(): Promise<void>;
  /** Find the `limit` nearest cards to a query vector. */
  searchByVector(vector: readonly number[], limit: number): Promise<readonly VectorMatch[]>;
}

/** @deprecated Use VectorStore. Kept for backwards compatibility. */
export type CardVectorStore = VectorStore;

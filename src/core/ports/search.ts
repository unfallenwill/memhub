/**
 * Search ports.
 *
 * The application service talks to retrieval backends through these
 * interfaces so it never depends on a concrete store (SQLite FTS, LanceDB
 * vectors) or on the optional semantic stack.
 *
 * CONTRACT: a backend MUST NOT record card access. The service records it
 * exactly once for the final, merged result set.
 */

import type { CardRecord, SearchHit } from '../domain/types.js';

/** A semantic search hit: a card plus a 0..1 similarity score. */
export interface SemanticHit {
  readonly card: CardRecord;
  readonly score: number;
}

/**
 * Keyword retrieval over the card store.
 *
 * Mirrors the public surface of src/db/search.ts (KeywordSearch).
 */
export interface KeywordSearchBackend {
  /**
   * Run a keyword query and return up to `limit` hits, best first.
   * CONTRACT: MUST NOT record access. The service records it exactly once.
   */
  search(query: string, limit: number): readonly SearchHit[];
  /**
   * Keyword fallback over active cards that are not vector-indexed yet,
   * so a freshly written card is always searchable (also used as the
   * fallback arm of semantic search).
   * CONTRACT: MUST NOT record access.
   */
  searchUnindexed(query: string, limit: number): readonly SearchHit[];
}

/**
 * Semantic retrieval over the vector index.
 *
 * Mirrors the read side of src/services/semantic-search.ts (SemanticSearch).
 */
export interface SemanticSearchBackend {
  /** Whether the semantic index is usable for queries. */
  readonly ready: boolean;
  /**
   * Whether the optional semantic stack packages are missing. Permanent
   * for the process lifetime.
   */
  readonly notInstalled: boolean;
  /**
   * Find the `limit` most similar active cards to the query.
   * CONTRACT: MUST NOT record access.
   */
  search(query: string, limit: number): Promise<readonly SemanticHit[]>;
}

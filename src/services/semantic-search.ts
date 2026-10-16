/**
 * Semantic search over the vector index.
 *
 * Embeds the query, finds the nearest card vectors in LanceDB and joins
 * the matches back to SQLite (the source of truth). Non-active cards are
 * filtered out here; the vector table may legitimately still contain
 * vectors for cards that were archived or superseded after indexing.
 */

import type { CardStore } from '../db/cards.js';
import type { CardRecord } from '../db/types.js';
import type { EmbeddingProvider } from '../embedding/embedder.js';
import type { CardVectorStore } from '../storage/vector-index.js';

/** A semantic search hit: a card plus a 0..1 similarity score. */
export interface SemanticHit {
  readonly card: CardRecord;
  readonly score: number;
}

/** Dependencies for SemanticSearch. */
export interface SemanticSearchDeps {
  readonly embedder: EmbeddingProvider;
  readonly vectors: CardVectorStore;
  readonly cards: CardStore;
}

/**
 * Vector-backed search. Readiness is managed externally (the daemon marks
 * the index ready once the worker has loaded the model and prepared the
 * vector table) so /healthz and /api/search agree on one flag.
 */
export class SemanticSearch {
  private readyFlag = false;

  constructor(private readonly deps: SemanticSearchDeps) {}

  /** Whether the semantic index is usable for queries. */
  get ready(): boolean {
    return this.readyFlag;
  }

  /** Mark the index ready (or not). Called by the daemon. */
  setReady(ready: boolean): void {
    this.readyFlag = ready;
  }

  /**
   * Find the `limit` most similar active cards to the query.
   * Does not record access; the caller (SearchService) does that once
   * after merging with the keyword fallback.
   */
  async search(query: string, limit: number): Promise<readonly SemanticHit[]> {
    if (limit <= 0) return [];
    const vectors = await this.deps.embedder.embed([query]);
    const queryVector = vectors[0];
    if (queryVector === undefined) return [];

    const matches = await this.deps.vectors.searchByVector(queryVector, limit);
    const hits: SemanticHit[] = [];
    for (const match of matches) {
      const card = this.deps.cards.getCard(match.cardId);
      if (card === null || card.status !== 'active') continue;
      hits.push({ card, score: distanceToScore(match.distance) });
    }
    return hits;
  }
}

/**
 * Convert a vector distance to a 0..1 similarity score.
 * Vectors are L2-normalized, so Euclidean distance lies in [0, 2] and
 * similarity = 1 - distance / 2 matches cosine similarity.
 */
export function distanceToScore(distance: number): number {
  return Math.max(0, Math.min(1, 1 - distance / 2));
}

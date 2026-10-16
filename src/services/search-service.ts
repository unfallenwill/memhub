/**
 * Unified search: keyword, semantic and auto modes.
 *
 * Every mode includes a keyword fallback over active cards that are not
 * vector-indexed yet, so a card is searchable from the moment it is
 * written. Results are deduplicated by card id and access is recorded
 * once per final result.
 */

import type { CardStore } from '../db/cards.js';
import type { KeywordSearch } from '../db/search.js';
import type { MatchedBy, SearchMode, SearchHit } from '../db/types.js';
import { SEMANTIC_INSTALL_HINT } from '../semantic-stack.js';
import type { SemanticSearch } from './semantic-search.js';

/** Thrown when semantic mode is requested but the index is not ready. */
export class IndexNotReadyError extends Error {
  constructor() {
    super('The semantic index is not ready yet');
    this.name = 'IndexNotReadyError';
  }
}

/** Thrown when semantic mode is requested but the semantic stack is missing. */
export class SemanticStackNotInstalledError extends Error {
  constructor() {
    super(SEMANTIC_INSTALL_HINT);
    this.name = 'SemanticStackNotInstalledError';
  }
}

/** One final search result. */
export interface SearchResultItem {
  readonly card: SearchHit['card'];
  readonly score: number;
  readonly matchedBy: MatchedBy;
}

/** The outcome of a search: ordered results plus the mode actually used. */
export interface SearchOutcome {
  readonly results: readonly SearchResultItem[];
  readonly modeUsed: 'keyword' | 'semantic';
}

/** Dependencies for SearchService. */
export interface SearchServiceDeps {
  readonly cards: CardStore;
  readonly keyword: KeywordSearch;
  /** Null when the daemon runs without a semantic index (or in tests). */
  readonly semantic: SemanticSearch | null;
}

/** Mode router over keyword and semantic retrieval. */
export class SearchService {
  constructor(private readonly deps: SearchServiceDeps) {}

  /**
   * Run a search.
   * - keyword: FTS5 + cues + unindexed-card fallback
   * - semantic: vector top-k + unindexed-card fallback (503-style error
   *   via IndexNotReadyError while the index is not ready, 501-style via
   *   SemanticStackNotInstalledError when the stack is not installed)
   * - auto: semantic when the index is ready, keyword otherwise
   */
  async search(query: string, mode: SearchMode, limit: number): Promise<SearchOutcome> {
    if (mode === 'keyword') {
      return { results: this.deps.keyword.search(query, limit), modeUsed: 'keyword' };
    }

    const semantic = this.deps.semantic;
    if (semantic === null || !semantic.ready) {
      if (mode === 'semantic') {
        if (semantic?.notInstalled === true) {
          throw new SemanticStackNotInstalledError();
        }
        throw new IndexNotReadyError();
      }
      return { results: this.deps.keyword.search(query, limit), modeUsed: 'keyword' };
    }

    const merged = new Map<number, SearchResultItem>();
    for (const hit of await semantic.search(query, limit)) {
      merged.set(hit.card.id, { card: hit.card, score: hit.score, matchedBy: 'semantic' });
    }
    for (const hit of this.deps.keyword.searchUnindexed(query, limit)) {
      if (!merged.has(hit.card.id)) {
        merged.set(hit.card.id, { card: hit.card, score: hit.score, matchedBy: hit.matchedBy });
      }
    }
    const results = [...merged.values()].slice(0, limit);
    this.deps.cards.recordAccess(results.map(item => item.card.id));
    return { results, modeUsed: 'semantic' };
  }
}

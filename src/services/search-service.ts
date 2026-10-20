/**
 * Unified search: keyword, semantic and auto modes.
 *
 * Every mode includes a keyword fallback over active cards that are not
 * vector-indexed yet, so a card is searchable from the moment it is
 * written. Results are deduplicated by card id.
 *
 * ACCESS BOOKKEEPING: the service owns it. The retrieval backends must not
 * record access themselves (see the `KeywordSearchBackend` and
 * `SemanticSearchBackend` contracts in core/ports/search.ts): the service
 * records it exactly once, for the final result set it returns, in every
 * mode.
 *
 * The service depends on ports, never on concrete stores, so it can be
 * exercised with plain in-memory fakes.
 */

import type { MatchedBy, SearchHit, SearchMode } from '../core/domain/types.js';
import { isIndexReady } from '../core/policies/index-readiness.js';
import { mergeSearchResults } from '../core/policies/search-merge.js';
import type { CardRepository } from '../core/ports/repositories.js';
import type { KeywordSearchBackend, SemanticSearchBackend } from '../core/ports/search.js';
import { SEMANTIC_INSTALL_HINT } from '../semantic-stack.js';

// Whether the vector index is ready for semantic search: the question has
// a single answer, the policy lives in the pure core layer. It is
// re-exported here because the service is the historical home of that
// helper.
export { isIndexReady } from '../core/policies/index-readiness.js';

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
  /** Card access bookkeeping (hit_count / last_accessed_at). */
  readonly cards: CardRepository;
  /** Keyword retrieval backend. */
  readonly keyword: KeywordSearchBackend;
  /** Null when the daemon runs without a semantic index (or in tests). */
  readonly semantic: SemanticSearchBackend | null;
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
      return this.finish(this.deps.keyword.search(query, limit), 'keyword', limit);
    }

    const semantic = this.deps.semantic;
    if (semantic === null || !isIndexReady(semantic)) {
      if (mode === 'semantic') {
        if (semantic?.notInstalled === true) {
          throw new SemanticStackNotInstalledError();
        }
        throw new IndexNotReadyError();
      }
      return this.finish(this.deps.keyword.search(query, limit), 'keyword', limit);
    }

    const semanticHits: SearchHit[] = (await semantic.search(query, limit)).map(hit => ({
      card: hit.card,
      score: hit.score,
      matchedBy: 'semantic',
    }));
    const keywordHits = this.deps.keyword.searchUnindexed(query, limit);
    const merged = mergeSearchResults(semanticHits, keywordHits, limit);
    return this.finish(merged, 'semantic', limit);
  }

  /**
   * Truncate to the limit and record the access of the final result set.
   *
   * The access is recorded exactly once per search, for the cards that are
   * actually returned - the backends never record it themselves.
   */
  private finish(
    items: readonly SearchResultItem[],
    modeUsed: 'keyword' | 'semantic',
    limit: number
  ): SearchOutcome {
    const results = items.slice(0, limit);
    this.deps.cards.recordAccess(results.map(item => item.card.id));
    return { results, modeUsed };
  }
}

/**
 * Business services built on the storage layer.
 */

export type { SemanticHit, SemanticSearchDeps } from './semantic-search.js';
export { distanceToScore, SemanticSearch } from './semantic-search.js';
export type { SearchResultItem, SearchOutcome, SearchServiceDeps } from './search-service.js';
export { IndexNotReadyError, SearchService } from './search-service.js';

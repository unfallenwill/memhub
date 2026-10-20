/**
 * Business services built on the storage layer.
 *
 * The services talk to ports (src/core/ports), never to concrete stores,
 * so they can be exercised with in-memory fakes.
 */

export type {
  CardInvalidateOutcome,
  CardServiceDeps,
  CardWriteOutcome,
  ListCardsOptions,
} from './card-service.js';
export { CardService } from './card-service.js';
export type { CreateServicesOptions, Services } from './context.js';
export { createServices } from './context.js';
export type { SemanticHit, SemanticSearchDeps } from './semantic-search.js';
export { distanceToScore, SemanticSearch } from './semantic-search.js';
export type { SearchResultItem, SearchOutcome, SearchServiceDeps } from './search-service.js';
export { IndexNotReadyError, isIndexReady, SearchService } from './search-service.js';
export { SemanticStackNotInstalledError } from './search-service.js';

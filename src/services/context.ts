/**
 * Service wiring.
 *
 * A reusable factory that assembles the application services over the
 * persistence ports. It is NOT the composition root: the runtime creates
 * exactly one `RuntimeContext` (src/runtime/context.ts) and hands the
 * very same instances to the HTTP app, the indexing worker, the job
 * timers and the semantic search.
 *
 * The services only know ports, so this module never sees a database
 * handle - the adapters are built by the db layer (src/db/context.ts).
 */

import type { DbContext } from '../db/context.js';
import type { EmbeddingProvider } from '../core/ports/embedding.js';
import type {
  ActivityRepository,
  AdminPasswordRepository,
  CardRepository,
  DeviceTokenRepository,
  EventRepository,
  WorkerStateRepository,
} from '../core/ports/repositories.js';
import type { KeywordSearchBackend, SemanticSearchBackend } from '../core/ports/search.js';
import type { VectorStore } from '../core/ports/vector.js';
import { CardService } from './card-service.js';
import { SearchService } from './search-service.js';
import { SemanticSearch } from './semantic-search.js';

/** Options for createServices(). */
export interface CreateServicesOptions {
  /** The persistence adapters the services run on. */
  readonly repositories: DbContext;
  /** Embedding provider of the semantic backend. */
  readonly embedder?: EmbeddingProvider | undefined;
  /** Vector store of the semantic backend. */
  readonly vectors?: VectorStore | undefined;
  /** Force keyword-only mode even when embedder/vectors are given. */
  readonly keywordOnly?: boolean | undefined;
}

/** The object graph the application services run on. */
export interface Services {
  /** Card data access. */
  readonly cards: CardRepository;
  /** The event queue. */
  readonly events: EventRepository;
  /** The audit trail. */
  readonly activity: ActivityRepository;
  /** Device-flow tokens. */
  readonly deviceTokens: DeviceTokenRepository;
  /** The state of the indexing worker. */
  readonly workerState: WorkerStateRepository;
  /** The admin password. */
  readonly adminPassword: AdminPasswordRepository;
  /** Keyword retrieval backend. */
  readonly keyword: KeywordSearchBackend;
  /** Semantic retrieval backend; null in keyword-only mode. */
  readonly semantic: SemanticSearchBackend | null;
  /** The search service (mode router over the two backends). */
  readonly search: SearchService;
  /** The card use cases. */
  readonly cardService: CardService;
}

/**
 * Build the service object graph over the given ports.
 *
 * The semantic backend is only created when both an embedding provider
 * and a vector store are given and keyword-only mode was not requested.
 */
export function createServices(options: CreateServicesOptions): Services {
  const { cards, events, activity, keyword } = options.repositories;
  const semantic = createSemanticBackend(options, cards);
  const search = new SearchService({ cards, keyword, semantic });
  const cardService = new CardService({ cards, events, activity });

  return {
    cards,
    events,
    activity,
    deviceTokens: options.repositories.deviceTokens,
    workerState: options.repositories.workerState,
    adminPassword: options.repositories.adminPassword,
    keyword,
    semantic,
    search,
    cardService,
  };
}

/** The semantic backend, or null when the daemon runs keyword-only. */
function createSemanticBackend(
  options: CreateServicesOptions,
  cards: CardRepository
): SemanticSearchBackend | null {
  if (options.keywordOnly === true) return null;
  const embedder = options.embedder;
  const vectors = options.vectors;
  if (embedder === undefined || vectors === undefined) return null;
  return new SemanticSearch({ embedder, vectors, cards });
}

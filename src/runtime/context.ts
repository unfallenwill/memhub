/**
 * The composition root.
 *
 * This is the ONE place where the persistence adapters are assembled.
 * Every consumer of the daemon (the HTTP app, the indexing worker, the
 * job timers, the semantic search) receives the very same instances
 * from here, so there is exactly one store graph per process.
 *
 * Before the composition root existed every consumer built its own graph
 * from the database handle: four CardStore instances, three EventStore
 * instances, three ActivityLog instances, two DeviceTokenStore instances
 * and two WorkerStateStore instances. They were stateless wrappers, so
 * nothing broke - but it also meant no store could ever be replaced by
 * a mock.
 */

import type { DatabaseSync } from 'node:sqlite';
import { systemClock, type Clock } from '../core/ports/clock.js';
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
import type { TransactionRunner } from '../core/ports/transaction.js';
import type { VectorStore } from '../core/ports/vector.js';
import { createDbContext } from '../db/context.js';
import type { CardService } from '../services/card-service.js';
import { createServices } from '../services/context.js';
import type { SearchService } from '../services/search-service.js';

/**
 * The object graph of one running MemHub process.
 *
 * Every field is a port (or the service built on top of them), so a
 * consumer can be tested with plain in-memory fakes.
 */
export interface RuntimeContext {
  /** The open database everything is built on. */
  readonly db: DatabaseSync;
  /** The clock every adapter reads its time from. */
  readonly clock: Clock;
  /** The transaction boundary of the database. */
  readonly transactions: TransactionRunner;
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
  /** The search service (mode router over the two backends). */
  readonly search: SearchService;
  /** The card use cases. */
  readonly cardService: CardService;
  /** Semantic retrieval backend; null in keyword-only mode. */
  readonly semantic: SemanticSearchBackend | null;
}

/** Options for createRuntimeContext(). */
export interface RuntimeContextOptions {
  /** The open database every adapter is built on. */
  readonly db: DatabaseSync;
  /** Clock handed to every adapter. Defaults to the system clock. */
  readonly clock?: Clock | undefined;
  /** Embedding provider of the semantic backend. */
  readonly embedder?: EmbeddingProvider | undefined;
  /** Vector store of the semantic backend. */
  readonly vectors?: VectorStore | undefined;
  /** Force keyword-only mode even when embedder/vectors are given. */
  readonly keywordOnly?: boolean | undefined;
}

/**
 * Build the object graph of a running MemHub process.
 *
 * The service factory (src/services/context.ts) knows how to build one
 * set of adapters over one database; this function is the only caller of
 * it in the production code, so the adapters exist exactly once.
 */
export function createRuntimeContext(options: RuntimeContextOptions): RuntimeContext {
  const clock = options.clock ?? systemClock;
  // The db layer builds the adapters over the connection; the runner is
  // bound to the connection (one runner per database), so the context
  // and the stores agree on the transaction depth.
  const repositories = createDbContext(options.db, clock);
  const services = createServices({
    repositories,
    embedder: options.embedder,
    vectors: options.vectors,
    keywordOnly: options.keywordOnly,
  });

  return {
    db: options.db,
    clock,
    transactions: repositories.transactions,
    cards: services.cards,
    events: services.events,
    activity: services.activity,
    deviceTokens: services.deviceTokens,
    workerState: services.workerState,
    adminPassword: services.adminPassword,
    keyword: services.keyword,
    search: services.search,
    cardService: services.cardService,
    semantic: services.semantic,
  };
}

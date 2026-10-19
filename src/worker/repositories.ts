/**
 * The repositories the worker layer needs.
 *
 * The worker never builds a store graph of its own: the composition
 * root (src/runtime/context.ts) hands it the very same instances the
 * HTTP app and the semantic search work on, so one process has exactly
 * one set of adapters over one database. A caller that has no runtime
 * context (the reindex CLI) builds them with the db layer factory
 * (createDbContext) and passes them in.
 *
 * This module is the worker's dependency contract: ports only, no
 * database handle.
 */

import type {
  ActivityRepository,
  CardRepository,
  EventRepository,
  WorkerStateRepository,
} from '../core/ports/repositories.js';
import type { TransactionRunner } from '../core/ports/transaction.js';

/** The repositories of one process, handed to the worker components. */
export interface WorkerRepositories {
  /** The event queue. */
  readonly events: EventRepository;
  /** The audit trail. */
  readonly activity: ActivityRepository;
  /** Card data access. */
  readonly cards: CardRepository;
  /** The state of the indexing worker. */
  readonly workerState: WorkerStateRepository;
  /** The transaction boundary. */
  readonly transactions: TransactionRunner;
}

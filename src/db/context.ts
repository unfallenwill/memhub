/**
 * One store graph over one database.
 *
 * The db layer is the only place that knows about SQLite. This factory
 * builds the adapters of one database once, so that every consumer of a
 * process works on the very same instances.
 *
 * The composition root (src/runtime/context.ts) calls it; the layers
 * above only ever see the ports it returns, never the database handle.
 */

import type { DatabaseSync } from 'node:sqlite';
import { systemClock, type Clock } from '../core/ports/clock.js';
import type {
  ActivityRepository,
  AdminPasswordRepository,
  CardRepository,
  DeviceTokenRepository,
  EventRepository,
  WorkerStateRepository,
} from '../core/ports/repositories.js';
import type { KeywordSearchBackend } from '../core/ports/search.js';
import type { TransactionRunner } from '../core/ports/transaction.js';
import { ActivityLog } from './activity.js';
import { AdminPasswordStore } from './admin-password.js';
import { CardStore } from './cards.js';
import { getTransactionRunner } from './database.js';
import { DeviceTokenStore } from './device-tokens.js';
import { EventStore } from './events.js';
import { KeywordSearch } from './keyword-search.js';
import { WorkerStateStore } from './worker-state.js';

/**
 * The persistence adapters of one database.
 *
 * Every field is a port, so a consumer can be handed plain in-memory
 * fakes instead of a real database.
 */
export interface DbContext {
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
  /** The transaction boundary of the database. */
  readonly transactions: TransactionRunner;
}

/**
 * Build the adapters of one database.
 *
 * The transaction runner is bound to the connection (one runner per
 * database), so the context and the stores agree on the transaction
 * depth.
 */
export function createDbContext(db: DatabaseSync, clock: Clock = systemClock): DbContext {
  const transactions = getTransactionRunner(db);
  const events = new EventStore(db, clock);
  const activity = new ActivityLog(db, clock);
  const cards = new CardStore(db, { events, activity, clock, transactions });

  return {
    cards,
    events,
    activity,
    deviceTokens: new DeviceTokenStore(db, clock),
    workerState: new WorkerStateStore(db),
    adminPassword: new AdminPasswordStore(db),
    keyword: new KeywordSearch(db),
    transactions,
  };
}

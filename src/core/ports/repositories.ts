/**
 * Repository ports.
 *
 * These interfaces are the stable contract between the application layer
 * (services / worker / http) and the persistence layer (db adapters). They
 * mirror the public surface of the existing SQLite stores one-to-one:
 *
 *   CardRepository        <- src/db/cards.ts        (CardStore)
 *   EventRepository       <- src/db/events.ts       (EventStore)
 *   ActivityRepository    <- src/db/activity.ts     (ActivityLog)
 *   DeviceTokenRepository <- src/db/device-tokens.ts(DeviceTokenStore)
 *   WorkerStateRepository <- src/db/worker-state.ts (WorkerStateStore)
 *   AdminPasswordRepository <- src/db/admin-password.ts  (AdminPasswordStore)
 *
 * Pure types only: no imports from other project layers, no runtime deps.
 */

import type {
  ActivityActor,
  ActivityPage,
  CardRecord,
  CardStats,
  CardStatus,
  CardType,
  CreateCardInput,
  CreateCardResult,
  DeviceTokenRecord,
  EventRow,
  QueueStats,
  UpdateCardInput,
  AdminAuthRecord,
} from '../domain/types.js';

/** A page of cards (id descending). */
export interface CardPage {
  readonly cards: readonly CardRecord[];
  readonly nextCursor: number | null;
}

/** Card data access. */
export interface CardRepository {
  /**
   * Create a card. Runs in a single transaction:
   * INSERT cards + INSERT events(card.created) + INSERT activity_log(hook).
   * A write whose title+body exactly matches an existing active card reuses
   * that card instead of creating a duplicate (idempotent hook writes).
   */
  createCard(input: CreateCardInput): CreateCardResult;
  /** Fetch one card, or null. */
  getCard(id: number): CardRecord | null;
  /** List cards (id descending) with optional filters and cursor pagination. */
  listCards(options: {
    readonly status?: CardStatus | undefined;
    readonly type?: CardType | undefined;
    readonly cursor?: number | null;
    readonly limit: number;
  }): CardPage;
  /** Update editable fields; null when the card does not exist. */
  updateCard(id: number, input: UpdateCardInput): CardRecord | null;
  /** Soft-delete: mark archived. Idempotent for already archived cards. */
  archiveCard(id: number): CardRecord | null;
  /** Invalidate a card: status=superseded with an optional successor. */
  invalidateCard(id: number, supersededBy: number | null): CardRecord | null;
  /** Record access: bump hit_count and last_accessed_at for the given ids. */
  recordAccess(ids: readonly number[]): void;
  /** Active cards still waiting for the vector index, oldest first. */
  listActiveUnindexed(): readonly CardRecord[];
  /** Ids of all active cards, ascending. Used by full reindex. */
  listActiveIds(): readonly number[];
  /** Mark every active card as unindexed (full vector rebuild). */
  resetActiveIndexedAt(): void;
  /** Record that indexing finished for the given cards. */
  setIndexedAt(ids: readonly number[], indexedAt: string): void;
  /** Card counts for /healthz and /api/queue. */
  stats(): CardStats;
}

/** Append-only access to the events queue. */
export interface EventRepository {
  /** Insert an event. Caller is responsible for the surrounding transaction. */
  enqueue(type: string, payload: unknown): void;
  /** Count and age of unprocessed events. */
  stats(): QueueStats;
  /** Fetch the next unconsumed batch: events with id > offset, ascending. */
  listBatchAfter(offset: number, limit: number): readonly EventRow[];
  /**
   * Mark one event processed. `error` records why a event was skipped
   * without retry (processed_at is still set, so it never blocks the queue).
   */
  markProcessed(id: number, error: string | null): void;
  /** Raw rows (debugging/tests). Ordered by id ascending. */
  listAll(): readonly EventRow[];
  /**
   * Delete the processed events below the offset that are older than the
   * cutoff. Returns the number of deleted rows.
   */
  deleteProcessedBefore(offset: number, cutoffIso: string): number;
}

/** Append-only access to the activity log. */
export interface ActivityRepository {
  /** Append an entry. Caller is responsible for the surrounding transaction. */
  append(
    actor: ActivityActor,
    action: string,
    cardId: number | null,
    detail?: Record<string, unknown> | undefined
  ): void;
  /** List entries, newest first, with id-based cursor pagination. */
  list(cursor: number | null, limit: number): ActivityPage;
}

/** Persistence for tokens minted by the device authorization flow. */
export interface DeviceTokenRepository {
  /** Insert a new device token; returns the stored record. */
  create(hash: string, label: string): DeviceTokenRecord;
  /** The active (non-revoked) token record for a hash, or null. */
  findActiveByHash(hash: string): DeviceTokenRecord | null;
  /** All tokens, newest first (for the web devices panel). */
  list(): readonly DeviceTokenRecord[];
  /** Update last_used_at for a token (throttled by the caller). */
  touchLastUsed(id: number): void;
  /** Revoke one token by id; returns false when it does not exist. */
  revoke(id: number): boolean;
  /** Revoke every token; returns how many were still active. */
  revokeAll(): number;
}

/** Typed access to the worker state key/value store. */
export interface WorkerStateRepository {
  /** Read a state value, or null when unset. */
  get(key: string): string | null;
  /** Upsert a state value. */
  set(key: string, value: string): void;
  /** The embedding model identity recorded by the worker, if any. */
  getModel(): string | null;
  /** Record the embedding model identity. */
  setModel(model: string): void;
  /** The last consumed event id (the worker offset). 0 when unset. */
  getLastEventId(): number;
  /** Advance the worker offset. */
  setLastEventId(id: number): void;
}

/** Single-row admin_auth persistence. */
export interface AdminPasswordRepository {
  /** The stored admin password, or null when not initialized. */
  get(): AdminAuthRecord | null;
  /** Set (or replace) the admin password hash. */
  set(passwordHash: string): void;
  /** Remove the admin password (back to uninitialized). */
  clear(): void;
}

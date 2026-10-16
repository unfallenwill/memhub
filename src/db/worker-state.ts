/**
 * worker_state table access.
 *
 * Key/value state for the indexing worker: the event offset
 * (indexer.last_event_id) and the embedding model identity
 * (indexer.model). M1 only reads/writes state; the worker itself
 * arrives in a later milestone.
 */

import type { DatabaseSync } from 'node:sqlite';

export const WORKER_STATE_KEYS = {
  lastEventId: 'indexer.last_event_id',
  model: 'indexer.model',
} as const;

/** Typed access to the worker_state table. */
export class WorkerStateStore {
  constructor(private readonly db: DatabaseSync) {}

  /** Read a state value, or null when unset. */
  get(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM worker_state WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  /** Upsert a state value. */
  set(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO worker_state(key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(key, value);
  }

  /** The embedding model identity recorded by the worker, if any. */
  getModel(): string | null {
    return this.get(WORKER_STATE_KEYS.model);
  }

  /** Record the embedding model identity. */
  setModel(model: string): void {
    this.set(WORKER_STATE_KEYS.model, model);
  }

  /** The last consumed event id (the worker offset). 0 when unset. */
  getLastEventId(): number {
    const value = this.get(WORKER_STATE_KEYS.lastEventId);
    if (value === null) return 0;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  /** Advance the worker offset. Must be called in the same transaction as the event processing it concludes. */
  setLastEventId(id: number): void {
    this.set(WORKER_STATE_KEYS.lastEventId, String(id));
  }
}

/**
 * Events table access.
 *
 * Events are the queue that drives async work (vector indexing in later
 * milestones). The HTTP write path only enqueues; a single worker will
 * consume them. Queue statistics feed /healthz and /api/queue.
 */

import type { DatabaseSync } from 'node:sqlite';

/** Queue statistics for /healthz and /api/queue. */
export interface QueueStats {
  readonly pendingEvents: number;
  /** Seconds since the oldest unprocessed event was created. */
  readonly oldestPendingEventAgeS: number;
}

/** Event row shape (internal). */
export interface EventRow {
  readonly id: number;
  readonly type: string;
  readonly payload: string;
  readonly createdAt: string;
  readonly processedAt: string | null;
  readonly error: string | null;
}

/** Append-only access to the events table. */
export class EventStore {
  constructor(private readonly db: DatabaseSync) {}

  /** Insert an event. Caller is responsible for the surrounding transaction. */
  enqueue(type: string, payload: unknown): void {
    this.db
      .prepare('INSERT INTO events(type, payload, created_at) VALUES (?, ?, ?)')
      .run(type, JSON.stringify(payload), new Date().toISOString());
  }

  /** Count and age of unprocessed events. */
  stats(): QueueStats {
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) AS pending,
           CAST((julianday('now') - julianday(MIN(created_at))) * 86400 AS INTEGER) AS age
         FROM events WHERE processed_at IS NULL`
      )
      .get() as { pending: number; age: number | null };
    return {
      pendingEvents: row.pending,
      oldestPendingEventAgeS: row.age ?? 0,
    };
  }

  /** Fetch the next unconsumed batch: events with id > offset, ascending. */
  listBatchAfter(offset: number, limit: number): readonly EventRow[] {
    return this.db
      .prepare(
        `SELECT id, type, payload, created_at AS createdAt,
                processed_at AS processedAt, error
         FROM events WHERE id > ? ORDER BY id LIMIT ?`
      )
      .all(offset, limit) as unknown as EventRow[];
  }

  /**
   * Mark one event processed. `error` records why a event was skipped
   * without retry (processed_at is still set, so it never blocks the queue).
   * Caller is responsible for the surrounding transaction.
   */
  markProcessed(id: number, error: string | null): void {
    this.db
      .prepare('UPDATE events SET processed_at = ?, error = ? WHERE id = ?')
      .run(new Date().toISOString(), error, id);
  }

  /** Raw rows (debugging/tests). Ordered by id ascending. */
  listAll(): readonly EventRow[] {
    return this.db
      .prepare(
        `SELECT id, type, payload, created_at AS createdAt,
                processed_at AS processedAt, error
         FROM events ORDER BY id`
      )
      .all() as unknown as EventRow[];
  }
}

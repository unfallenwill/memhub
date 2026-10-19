/**
 * Events table access.
 *
 * Events are the queue that drives async work (vector indexing in later
 * milestones). The HTTP write path only enqueues; a single worker will
 * consume them. Queue statistics feed /healthz and /api/queue.
 */

import type { DatabaseSync } from 'node:sqlite';
import type { EventRow, QueueStats } from '../core/domain/types.js';
import { systemClock, type Clock } from '../core/ports/clock.js';
import type { EventRepository } from '../core/ports/repositories.js';

// The queue/event types now live in the pure domain layer; they are
// re-exported here so existing import points keep working.
export type { EventRow, QueueStats } from '../core/domain/types.js';

/** Append-only access to the events table. */
export class EventStore implements EventRepository {
  private readonly clock: Clock;

  constructor(
    private readonly db: DatabaseSync,
    clock: Clock = systemClock
  ) {
    this.clock = clock;
  }

  /** Insert an event. Caller is responsible for the surrounding transaction. */
  enqueue(type: string, payload: unknown): void {
    this.db
      .prepare('INSERT INTO events(type, payload, created_at) VALUES (?, ?, ?)')
      .run(type, JSON.stringify(payload), this.clock.isoNow());
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
      .run(this.clock.isoNow(), error, id);
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

  /**
   * Delete the events that are safe to lose: already processed, strictly
   * below the worker offset, and older than the cutoff.
   * Returns the number of deleted rows.
   *
   * Runs inside the caller's transaction (the worker calls it while
   * committing the job.retention_cleanup event).
   */
  deleteProcessedBefore(offset: number, cutoffIso: string): number {
    const result = this.db
      .prepare(
        `DELETE FROM events
         WHERE processed_at IS NOT NULL AND id < ? AND created_at < ?`
      )
      .run(offset, cutoffIso);
    return Number(result.changes);
  }
}

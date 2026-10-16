/**
 * Event retention.
 *
 * The events table is a queue, not an audit log. Processed events below
 * the worker offset that are older than RETENTION_DAYS are deleted by the
 * daily job.retention_cleanup job. activity_log is the audit trail and is
 * never cleaned up.
 */

import type { DatabaseSync } from 'node:sqlite';

/** How long processed events are kept. */
export const RETENTION_DAYS = 7;

/** Milliseconds in a day (used by tests to build timestamps). */
export const DAY_MS = 86_400_000;

/**
 * Delete events that are safe to lose: already processed, strictly below
 * the current worker offset, and older than the retention window.
 * Returns the number of deleted rows.
 *
 * Runs inside the caller's transaction (the worker calls it while
 * committing the job.retention_cleanup event).
 */
export function runRetentionCleanup(
  db: DatabaseSync,
  offset: number,
  now: Date = new Date()
): number {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * DAY_MS).toISOString();
  const result = db
    .prepare(
      `DELETE FROM events
       WHERE processed_at IS NOT NULL AND id < ? AND created_at < ?`
    )
    .run(offset, cutoff);
  return Number(result.changes);
}

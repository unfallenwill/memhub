/**
 * Timer-driven jobs.
 *
 * The timers only enqueue events (job.compensation_scan hourly,
 * job.retention_cleanup daily); the worker does the actual work when it
 * consumes them. This keeps a single execution path for indexing and
 * cleanup, and makes the queue the observable record of timer activity.
 */

import type { DatabaseSync } from 'node:sqlite';
import { withTransaction } from '../db/database.js';
import { EventStore } from '../db/events.js';

/** Options for JobTimers. */
export interface JobTimersOptions {
  /** Compensation scan interval (default: 1 hour). */
  readonly compensationIntervalMs?: number | undefined;
  /** Retention cleanup interval (default: 1 day). */
  readonly retentionIntervalMs?: number | undefined;
}

/** Enqueues the periodic job events. */
export class JobTimers {
  private readonly db: DatabaseSync;
  private readonly events: EventStore;
  private readonly compensationIntervalMs: number;
  private readonly retentionIntervalMs: number;
  private timers: NodeJS.Timeout[] = [];

  constructor(db: DatabaseSync, options: JobTimersOptions = {}) {
    this.db = db;
    this.events = new EventStore(db);
    this.compensationIntervalMs = options.compensationIntervalMs ?? 3_600_000;
    this.retentionIntervalMs = options.retentionIntervalMs ?? 86_400_000;
  }

  /** Start the timers. Idempotent. The first fire is one full interval after start. */
  start(): void {
    if (this.timers.length > 0) return;
    const compensation = setInterval(() => {
      this.enqueue('job.compensation_scan');
    }, this.compensationIntervalMs);
    const retention = setInterval(() => {
      this.enqueue('job.retention_cleanup');
    }, this.retentionIntervalMs);
    this.timers = [compensation, retention];
    // Never keep the process alive on our own; the HTTP server owns the lifetime.
    for (const timer of this.timers) {
      timer.unref?.();
    }
  }

  /** Stop the timers. Idempotent. */
  stop(): void {
    for (const timer of this.timers) {
      clearInterval(timer);
    }
    this.timers = [];
  }

  private enqueue(type: 'job.compensation_scan' | 'job.retention_cleanup'): void {
    withTransaction(this.db, () => {
      this.events.enqueue(type, {});
    });
  }
}

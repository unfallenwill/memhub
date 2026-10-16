/**
 * activity_log table access.
 *
 * The activity log is an append-only audit trail (who did what to which
 * card). It is never cleaned up and powers the read-only activity feed.
 */

import type { DatabaseSync } from 'node:sqlite';
import type { ActivityActor } from './types.js';

/** An activity log entry. */
export interface ActivityEntry {
  readonly id: number;
  readonly ts: string;
  readonly actor: ActivityActor;
  readonly action: string;
  readonly cardId: number | null;
  /** Parsed detail object, or null. */
  readonly detail: Record<string, unknown> | null;
}

/** A page of activity entries. */
export interface ActivityPage {
  readonly entries: readonly ActivityEntry[];
  readonly nextCursor: number | null;
}

interface ActivityRow {
  id: number;
  ts: string;
  actor: string;
  action: string;
  card_id: number | null;
  detail: string | null;
}

/** Append-only access to the activity_log table. */
export class ActivityLog {
  constructor(private readonly db: DatabaseSync) {}

  /** Append an entry. Caller is responsible for the surrounding transaction. */
  append(
    actor: ActivityActor,
    action: string,
    cardId: number | null,
    detail?: Record<string, unknown> | undefined
  ): void {
    this.db
      .prepare(
        'INSERT INTO activity_log(ts, actor, action, card_id, detail) VALUES (?, ?, ?, ?, ?)'
      )
      .run(
        new Date().toISOString(),
        actor,
        action,
        cardId,
        detail === undefined ? null : JSON.stringify(detail)
      );
  }

  /** List entries, newest first, with id-based cursor pagination. */
  list(cursor: number | null, limit: number): ActivityPage {
    const fetchLimit = limit + 1;
    const rows: ActivityRow[] =
      cursor === null
        ? (this.db
            .prepare(
              `SELECT id, ts, actor, action, card_id, detail FROM activity_log
               ORDER BY id DESC LIMIT ?`
            )
            .all(fetchLimit) as unknown as ActivityRow[])
        : (this.db
            .prepare(
              `SELECT id, ts, actor, action, card_id, detail FROM activity_log
               WHERE id < ? ORDER BY id DESC LIMIT ?`
            )
            .all(cursor, fetchLimit) as unknown as ActivityRow[]);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      entries: page.map(toEntry),
      nextCursor: hasMore ? page[page.length - 1].id : null,
    };
  }
}

function toEntry(row: ActivityRow): ActivityEntry {
  let detail: Record<string, unknown> | null = null;
  if (row.detail !== null) {
    try {
      detail = JSON.parse(row.detail) as Record<string, unknown>;
    } catch {
      detail = null;
    }
  }
  return {
    id: row.id,
    ts: row.ts,
    actor: row.actor as ActivityActor,
    action: row.action,
    cardId: row.card_id,
    detail,
  };
}

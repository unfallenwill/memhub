/**
 * Card repository.
 *
 * SQLite is the single source of truth for cards. The FTS5 index is kept
 * in sync by triggers (see migrations). All multi-statement operations run
 * in a single transaction so the write path stays constant and fast.
 *
 * The store implements the `CardRepository` port: the clock and the
 * transaction runner are injected, so the store never reads the ambient
 * time and never talks to a database driver directly.
 */

import type { DatabaseSync } from 'node:sqlite';
import { getTransactionRunner } from './database.js';
import type { ActivityLog } from './activity.js';
import type { EventStore } from './events.js';
import { SELECT_COLUMNS, toCard, type CardRow } from './row-mappers.js';
import { isExactDuplicate } from '../core/policies/card-dedupe.js';
import { diffCard } from '../core/policies/card-diff.js';
import { invalidSupersedeTargetMessage } from '../core/policies/card-lifecycle.js';
import { systemClock, type Clock } from '../core/ports/clock.js';
import type { TransactionRunner } from '../core/ports/transaction.js';
import type { CardPage, CardRepository } from '../core/ports/repositories.js';
import type {
  CardRecord,
  CardStats,
  CardStatus,
  CardType,
  CreateCardInput,
  CreateCardResult,
  UpdateCardInput,
} from './types.js';

// The page type now lives in the port layer; it is re-exported here so
// existing import points keep working.
export type { CardPage } from '../core/ports/repositories.js';

/** Collaborators of the card store. */
export interface CardStoreDeps {
  /** The event queue; card writes enqueue their events. */
  readonly events: EventStore;
  /** The audit trail; card writes append their entries. */
  readonly activity: ActivityLog;
  /** Source of every timestamp. Defaults to the system clock. */
  readonly clock?: Clock | undefined;
  /** Transaction boundary. Defaults to the runner of the given database. */
  readonly transactions?: TransactionRunner | undefined;
}

/**
 * Card data access. One instance per open database.
 * The event store and activity log are injected so card writes can
 * enqueue events and audit entries in the same transaction.
 */
export class CardStore implements CardRepository {
  private readonly events: EventStore;
  private readonly activity: ActivityLog;
  private readonly clock: Clock;
  private readonly transactions: TransactionRunner;

  constructor(
    private readonly db: DatabaseSync,
    deps: CardStoreDeps
  ) {
    this.events = deps.events;
    this.activity = deps.activity;
    this.clock = deps.clock ?? systemClock;
    this.transactions = deps.transactions ?? getTransactionRunner(db);
  }

  /**
   * Create a card. Runs in a single transaction:
   * INSERT cards + INSERT events(card.created) + INSERT activity_log(hook).
   * A write whose title+body exactly matches an existing active card reuses
   * that card instead of creating a duplicate (idempotent hook writes).
   */
  createCard(input: CreateCardInput): CreateCardResult {
    return this.transactions.transaction(() => {
      // The query narrows the candidates down; the policy decides whether
      // the found card is really the same card.
      const existing = this.db
        .prepare(
          `SELECT id, title, body FROM cards WHERE status = 'active' AND title = ? AND body = ?
           ORDER BY id DESC LIMIT 1`
        )
        .get(input.title, input.body) as { id: number; title: string; body: string } | undefined;
      if (existing && isExactDuplicate(existing, input)) {
        this.activity.append('hook', 'card.deduplicated', existing.id, {
          title: input.title,
          writer: input.writer ?? null,
        });
        return { id: existing.id, indexed: false, deduplicated: true };
      }

      const now = this.clock.isoNow();
      const result = this.db
        .prepare(
          `INSERT INTO cards(title, body, type, cues, confidence, writer, source,
             status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`
        )
        .run(
          input.title,
          input.body,
          input.type,
          JSON.stringify(input.cues),
          input.confidence,
          input.writer ?? null,
          input.source ?? null,
          now,
          now
        );
      const id = Number(result.lastInsertRowid);
      this.events.enqueue('card.created', { card_id: id });
      this.activity.append('hook', 'card.created', id, {
        title: input.title,
        type: input.type,
        writer: input.writer ?? null,
      });
      return { id, indexed: false, deduplicated: false };
    });
  }

  /** Fetch one card, or null. */
  getCard(id: number): CardRecord | null {
    const row = this.db.prepare(`SELECT ${SELECT_COLUMNS} FROM cards WHERE id = ?`).get(id) as
      | CardRow
      | undefined;
    return row ? toCard(row) : null;
  }

  /** List cards (id descending) with optional filters and cursor pagination. */
  listCards(options: {
    status?: CardStatus | undefined;
    type?: CardType | undefined;
    cursor?: number | null;
    limit: number;
  }): CardPage {
    const conditions: string[] = [];
    const params: (string | number)[] = [];
    if (options.status) {
      conditions.push('status = ?');
      params.push(options.status);
    }
    if (options.type) {
      conditions.push('type = ?');
      params.push(options.type);
    }
    const cursor = options.cursor ?? null;
    if (cursor !== null) {
      conditions.push('id < ?');
      params.push(cursor);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(options.limit + 1);
    const rows = this.db
      .prepare(`SELECT ${SELECT_COLUMNS} FROM cards ${where} ORDER BY id DESC LIMIT ?`)
      .all(...params) as unknown as CardRow[];
    const hasMore = rows.length > options.limit;
    const page = hasMore ? rows.slice(0, options.limit) : rows;
    return {
      cards: page.map(toCard),
      nextCursor: hasMore ? page[page.length - 1].id : null,
    };
  }

  /**
   * Update editable fields. Changing title/body/cues resets indexed_at
   * (the vector index is stale) and enqueues a card.updated event.
   */
  updateCard(id: number, input: UpdateCardInput): CardRecord | null {
    const current = this.getCard(id);
    if (!current) return null;

    const next = {
      title: input.title ?? current.title,
      body: input.body ?? current.body,
      type: input.type ?? current.type,
      cues: input.cues ?? current.cues,
      confidence: input.confidence ?? current.confidence,
    };

    const diff = diffCard(current, next);
    const contentChanged = diff.contentChanged;

    return this.transactions.transaction(() => {
      const now = this.clock.isoNow();
      this.db
        .prepare(
          `UPDATE cards
           SET title = ?, body = ?, type = ?, cues = ?, confidence = ?,
               updated_at = ?,
               indexed_at = CASE WHEN ? THEN NULL ELSE indexed_at END
           WHERE id = ?`
        )
        .run(
          next.title,
          next.body,
          next.type,
          JSON.stringify(next.cues),
          next.confidence,
          now,
          contentChanged ? 1 : 0,
          id
        );
      const changed = diff.changed;
      if (contentChanged) {
        this.events.enqueue('card.updated', { card_id: id, changed });
      }
      this.activity.append('user:web', 'card.updated', id, { changed });
      const updated = this.getCard(id);
      if (!updated) throw new Error(`card ${id} disappeared during update`);
      return updated;
    });
  }

  /** Soft-delete: mark archived. Idempotent for already archived cards. */
  archiveCard(id: number): CardRecord | null {
    const current = this.getCard(id);
    if (!current) return null;
    if (current.status === 'archived') return current;
    return this.transactions.transaction(() => {
      const now = this.clock.isoNow();
      this.db
        .prepare(
          `UPDATE cards SET status = 'archived', archived_at = ?, updated_at = ? WHERE id = ?`
        )
        .run(now, now, id);
      this.activity.append('user:web', 'card.archived', id);
      const updated = this.getCard(id);
      if (!updated) throw new Error(`card ${id} disappeared during archive`);
      return updated;
    });
  }

  /** Invalidate a card: status=superseded with an optional successor. */
  invalidateCard(id: number, supersededBy: number | null): CardRecord | null {
    const current = this.getCard(id);
    if (!current) return null;
    if (supersededBy !== null) {
      const target = this.getCard(supersededBy);
      if (!target) {
        throw new InvalidSupersedeTargetError(supersededBy);
      }
    }
    return this.transactions.transaction(() => {
      const now = this.clock.isoNow();
      this.db
        .prepare(
          `UPDATE cards SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ?`
        )
        .run(supersededBy, now, id);
      this.activity.append('user:web', 'card.invalidated', id, {
        superseded_by: supersededBy,
      });
      const updated = this.getCard(id);
      if (!updated) throw new Error(`card ${id} disappeared during invalidate`);
      return updated;
    });
  }

  /** Record access: bump hit_count and last_accessed_at for the given ids. */
  recordAccess(ids: readonly number[]): void {
    if (ids.length === 0) return;
    this.transactions.transaction(() => {
      const stmt = this.db.prepare(
        `UPDATE cards SET hit_count = hit_count + 1, last_accessed_at = ? WHERE id = ?`
      );
      const now = this.clock.isoNow();
      for (const id of ids) {
        stmt.run(now, id);
      }
    });
  }

  /** Active cards still waiting for the vector index, oldest first. */
  listActiveUnindexed(): readonly CardRecord[] {
    const rows = this.db
      .prepare(
        `SELECT ${SELECT_COLUMNS} FROM cards
         WHERE status = 'active' AND indexed_at IS NULL
         ORDER BY id`
      )
      .all() as unknown as CardRow[];
    return rows.map(toCard);
  }

  /** Ids of all active cards, ascending. Used by full reindex. */
  listActiveIds(): readonly number[] {
    const rows = this.db
      .prepare('SELECT id FROM cards WHERE status = ? ORDER BY id')
      .all('active') as unknown as { id: number }[];
    return rows.map(row => row.id);
  }

  /**
   * Mark every active card as unindexed. Used when the vector index must
   * be rebuilt from scratch (model change, `memhub reindex`).
   * Caller is responsible for the surrounding transaction.
   */
  resetActiveIndexedAt(): void {
    this.db.prepare(`UPDATE cards SET indexed_at = NULL WHERE status = 'active'`).run();
  }

  /**
   * Record that indexing finished for the given cards.
   * Caller is responsible for the surrounding transaction.
   */
  setIndexedAt(ids: readonly number[], indexedAt: string): void {
    const stmt = this.db.prepare('UPDATE cards SET indexed_at = ? WHERE id = ?');
    for (const id of ids) {
      stmt.run(indexedAt, id);
    }
  }

  /** Card counts for /healthz and /api/queue. */
  stats(): CardStats {
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
           SUM(CASE WHEN status = 'active' AND indexed_at IS NULL THEN 1 ELSE 0 END)
             AS pending_index,
           CAST(
             (julianday('now') - julianday(MIN(
               CASE WHEN status = 'active' AND indexed_at IS NULL THEN created_at END
             ))) * 86400 AS INTEGER
           ) AS oldest_age
         FROM cards`
      )
      .get() as {
      total: number;
      active: number | null;
      pending_index: number | null;
      oldest_age: number | null;
    };
    return {
      total: row.total,
      active: row.active ?? 0,
      pendingIndex: row.pending_index ?? 0,
      oldestUnindexedAgeS: Math.max(0, row.oldest_age ?? 0),
    };
  }
}

/** Thrown when an invalidate request points at a non-existent successor. */
export class InvalidSupersedeTargetError extends Error {
  constructor(readonly targetId: number) {
    super(invalidSupersedeTargetMessage(targetId));
    this.name = 'InvalidSupersedeTargetError';
  }
}

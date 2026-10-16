/**
 * Core card domain types.
 *
 * A card is a small, opinionated, cue-based memory record. SQLite is the
 * single source of truth; everything else (FTS index, vectors) is derived.
 */

/** Supported card types. */
export const CARD_TYPES = ['fact', 'preference', 'decision', 'insight', 'pattern'] as const;
export type CardType = (typeof CARD_TYPES)[number];

/** Card lifecycle statuses. */
export const CARD_STATUSES = ['active', 'archived', 'merged', 'rejected', 'superseded'] as const;
export type CardStatus = (typeof CARD_STATUSES)[number];

/** A card row mapped to a domain object. */
export interface CardRecord {
  readonly id: number;
  readonly title: string;
  readonly body: string;
  readonly type: CardType;
  readonly cues: readonly string[];
  readonly confidence: number;
  readonly writer: string | null;
  readonly source: string | null;
  readonly status: CardStatus;
  readonly mergedInto: number | null;
  readonly supersededBy: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** NULL means the card is waiting to be embedded into the vector index. */
  readonly indexedAt: string | null;
  readonly lastAccessedAt: string | null;
  readonly hitCount: number;
  readonly archivedAt: string | null;
}

/** Input accepted by the card creation endpoint / store. */
export interface CreateCardInput {
  readonly title: string;
  readonly body: string;
  readonly type: CardType;
  readonly cues: readonly string[];
  readonly confidence: number;
  readonly writer?: string | undefined;
  readonly source?: string | undefined;
}

/** Fields that may be changed via PATCH. */
export interface UpdateCardInput {
  readonly title?: string | undefined;
  readonly body?: string | undefined;
  readonly type?: CardType | undefined;
  readonly cues?: readonly string[] | undefined;
  readonly confidence?: number | undefined;
}

/** Result of a card write. */
export interface CreateCardResult {
  readonly id: number;
  /** Always false at write time: indexing happens asynchronously. */
  readonly indexed: false;
  /** True when an identical active card was reused instead of creating one. */
  readonly deduplicated: boolean;
}

/** Aggregated card statistics for /healthz and /api/queue. */
export interface CardStats {
  readonly total: number;
  readonly active: number;
  /** Active cards still waiting for the vector index. */
  readonly pendingIndex: number;
  /** Seconds since the oldest active unindexed card was created. */
  readonly oldestUnindexedAgeS: number;
}

/** How a card matched a query. */
export type MatchedBy = 'fts' | 'cues' | 'fallback' | 'semantic';

/** A single search hit. */
export interface SearchHit {
  readonly card: CardRecord;
  readonly score: number;
  readonly matchedBy: MatchedBy;
}

/** Search modes accepted by POST /api/search. */
export const SEARCH_MODES = ['auto', 'semantic', 'keyword'] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];

/** Actors recorded in the activity log. */
export type ActivityActor = 'hook' | 'worker' | 'user:web' | 'timer';

/** Domain event types (see the events table). */
export type EventType = 'card.created' | 'card.updated';

/** Timer-driven job commands enqueued as events (processed by later milestones). */
export type JobEventType = 'job.compensation_scan' | 'job.retention_cleanup';

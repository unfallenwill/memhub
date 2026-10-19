/**
 * Row mappers.
 *
 * The single place that turns database rows into domain objects. The card
 * mapper and the cue parser live here so the card store and the keyword
 * search backend can never drift apart: both read the same columns and
 * parse the `cues` JSON exactly the same way.
 */

import type { CardRecord, CardStatus, CardType } from '../core/domain/types.js';

/** A raw row of the `cards` table. */
export interface CardRow {
  id: number;
  title: string;
  body: string;
  type: string;
  cues: string;
  confidence: number;
  writer: string | null;
  source: string | null;
  status: string;
  merged_into: number | null;
  superseded_by: number | null;
  created_at: string;
  updated_at: string;
  indexed_at: string | null;
  last_accessed_at: string | null;
  hit_count: number;
  archived_at: string | null;
}

/** The card columns, in the order the domain object expects them. */
const CARD_COLUMNS = [
  'id',
  'title',
  'body',
  'type',
  'cues',
  'confidence',
  'writer',
  'source',
  'status',
  'merged_into',
  'superseded_by',
  'created_at',
  'updated_at',
  'indexed_at',
  'last_accessed_at',
  'hit_count',
  'archived_at',
] as const;

/** The card columns every full-card read selects. */
export const SELECT_COLUMNS = CARD_COLUMNS.join(', ');

/**
 * The same columns, qualified with a table alias (needed when the cards
 * table is joined with another one, e.g. the FTS mirror).
 */
export function selectCardColumns(alias: string): string {
  return CARD_COLUMNS.map(column => `${alias}.${column}`).join(', ');
}

/**
 * Parse the JSON-encoded `cues` column.
 *
 * Edge cases (unchanged behaviour):
 * - a JSON array of strings is returned as-is
 * - non-string elements are filtered out
 * - JSON that is not an array yields an empty list
 * - malformed JSON yields an empty list
 */
export function toCues(json: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((cue): cue is string => typeof cue === 'string');
}

/** Map a row of the `cards` table to its domain object. */
export function toCard(row: CardRow): CardRecord {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    type: row.type as CardType,
    cues: toCues(row.cues),
    confidence: row.confidence,
    writer: row.writer,
    source: row.source,
    status: row.status as CardStatus,
    mergedInto: row.merged_into,
    supersededBy: row.superseded_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    indexedAt: row.indexed_at,
    lastAccessedAt: row.last_accessed_at,
    hitCount: row.hit_count,
    archivedAt: row.archived_at,
  };
}

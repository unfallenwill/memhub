/**
 * Mapping of the domain objects to the API response bodies.
 *
 * The wire format is snake_case and the field order is stable, so a
 * client can diff two responses without noise.
 */

import type { CardRecord } from '../core/domain/types.js';

/** Serialize a card for API responses (camelCase, stable field order). */
export function serializeCard(card: CardRecord): Record<string, unknown> {
  return {
    id: card.id,
    title: card.title,
    body: card.body,
    type: card.type,
    cues: card.cues,
    confidence: card.confidence,
    writer: card.writer,
    source: card.source,
    status: card.status,
    merged_into: card.mergedInto,
    superseded_by: card.supersededBy,
    created_at: card.createdAt,
    updated_at: card.updatedAt,
    indexed_at: card.indexedAt,
    last_accessed_at: card.lastAccessedAt,
    hit_count: card.hitCount,
    archived_at: card.archivedAt,
  };
}

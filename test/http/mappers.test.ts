import { describe, expect, it } from 'vitest';
import { serializeCard } from '../../src/http/mappers.js';
import type { CardRecord } from '../../src/core/domain/types.js';

/** A card with every field filled in. */
const CARD: CardRecord = {
  id: 7,
  title: 'docker deploy',
  body: 'run the compose file',
  type: 'fact',
  cues: ['docker', 'compose'],
  confidence: 0.75,
  writer: 'hook',
  source: 'session',
  status: 'active',
  mergedInto: null,
  supersededBy: null,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-02T00:00:00.000Z',
  indexedAt: '2024-01-03T00:00:00.000Z',
  lastAccessedAt: '2024-01-04T00:00:00.000Z',
  hitCount: 3,
  archivedAt: null,
};

describe('serializeCard', () => {
  it('maps every field to its snake_case name', () => {
    expect(serializeCard(CARD)).toEqual({
      id: 7,
      title: 'docker deploy',
      body: 'run the compose file',
      type: 'fact',
      cues: ['docker', 'compose'],
      confidence: 0.75,
      writer: 'hook',
      source: 'session',
      status: 'active',
      merged_into: null,
      superseded_by: null,
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-02T00:00:00.000Z',
      indexed_at: '2024-01-03T00:00:00.000Z',
      last_accessed_at: '2024-01-04T00:00:00.000Z',
      hit_count: 3,
      archived_at: null,
    });
  });

  it('keeps a stable field order', () => {
    expect(Object.keys(serializeCard(CARD))).toEqual([
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
    ]);
  });

  it('keeps the null values of an empty card', () => {
    const empty = serializeCard({
      ...CARD,
      writer: null,
      source: null,
      mergedInto: null,
      supersededBy: null,
      indexedAt: null,
      lastAccessedAt: null,
      archivedAt: null,
      hitCount: 0,
    });

    expect(empty.writer).toBeNull();
    expect(empty.source).toBeNull();
    expect(empty.merged_into).toBeNull();
    expect(empty.superseded_by).toBeNull();
    expect(empty.indexed_at).toBeNull();
    expect(empty.last_accessed_at).toBeNull();
    expect(empty.archived_at).toBeNull();
    expect(empty.hit_count).toBe(0);
  });

  it('does not change the card it serializes', () => {
    const card = { ...CARD };
    serializeCard(card);

    expect(card).toEqual(CARD);
  });
});

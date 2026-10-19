/**
 * The row mappers are the single place where database rows become domain
 * objects. The cue parser is shared by the card store and the keyword
 * search backend, so its edge cases are pinned here.
 */

import { describe, expect, it } from 'vitest';
import {
  SELECT_COLUMNS,
  selectCardColumns,
  toCard,
  toCues,
  type CardRow,
} from '../../src/db/row-mappers.js';

describe('toCues', () => {
  it('parses a JSON array of strings', () => {
    expect(toCues('["alpha","beta"]')).toEqual(['alpha', 'beta']);
  });

  it('returns an empty list for JSON that is not an array', () => {
    expect(toCues('{"a":1}')).toEqual([]);
    expect(toCues('"text"')).toEqual([]);
    expect(toCues('42')).toEqual([]);
    expect(toCues('null')).toEqual([]);
    expect(toCues('true')).toEqual([]);
  });

  it('filters out the non-string elements of an array', () => {
    expect(toCues('["a",1,null,{},["x"],true,"b"]')).toEqual(['a', 'b']);
  });

  it('returns an empty list for malformed JSON', () => {
    expect(toCues('not json at all')).toEqual([]);
    expect(toCues('[unclosed')).toEqual([]);
    expect(toCues('')).toEqual([]);
  });

  it('returns an empty list for an empty array', () => {
    expect(toCues('[]')).toEqual([]);
  });
});

describe('toCard', () => {
  const row: CardRow = {
    id: 7,
    title: 'A title',
    body: 'A body',
    type: 'decision',
    cues: '["one","two"]',
    confidence: 0.75,
    writer: 'hook',
    source: 'cli',
    status: 'active',
    merged_into: null,
    superseded_by: null,
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-02T00:00:00.000Z',
    indexed_at: '2024-01-03T00:00:00.000Z',
    last_accessed_at: '2024-01-04T00:00:00.000Z',
    hit_count: 5,
    archived_at: null,
  };

  it('maps every column of the row', () => {
    const card = toCard(row);
    expect(card).toEqual({
      id: 7,
      title: 'A title',
      body: 'A body',
      type: 'decision',
      cues: ['one', 'two'],
      confidence: 0.75,
      writer: 'hook',
      source: 'cli',
      status: 'active',
      mergedInto: null,
      supersededBy: null,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-02T00:00:00.000Z',
      indexedAt: '2024-01-03T00:00:00.000Z',
      lastAccessedAt: '2024-01-04T00:00:00.000Z',
      hitCount: 5,
      archivedAt: null,
    });
  });

  it('parses the cues column with the shared parser', () => {
    expect(toCard({ ...row, cues: '["a",2,"b"]' }).cues).toEqual(['a', 'b']);
    expect(toCard({ ...row, cues: 'broken' }).cues).toEqual([]);
    expect(toCard({ ...row, cues: '{"a":1}' }).cues).toEqual([]);
  });

  it('keeps the nullable columns null', () => {
    const card = toCard({
      ...row,
      writer: null,
      source: null,
      merged_into: 3,
      superseded_by: 4,
      indexed_at: null,
      last_accessed_at: null,
      archived_at: '2024-01-05T00:00:00.000Z',
    });
    expect(card.writer).toBeNull();
    expect(card.source).toBeNull();
    expect(card.mergedInto).toBe(3);
    expect(card.supersededBy).toBe(4);
    expect(card.indexedAt).toBeNull();
    expect(card.lastAccessedAt).toBeNull();
    expect(card.archivedAt).toBe('2024-01-05T00:00:00.000Z');
  });
});

describe('the card column list', () => {
  it('selects every column the mapper reads', () => {
    const columns = SELECT_COLUMNS.split(',').map(column => column.trim());
    expect(columns).toEqual([
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

  it('qualifies the columns with a table alias for joins', () => {
    const columns = selectCardColumns('c')
      .split(',')
      .map(column => column.trim());
    expect(columns[0]).toBe('c.id');
    expect(columns).toHaveLength(SELECT_COLUMNS.split(',').length);
  });
});

import { describe, expect, it } from 'vitest';
import { diffCard, type CardDiffInput } from '../../../src/core/policies/card-diff.js';

/** A stored card with everything filled in. */
function card(overrides: Partial<CardDiffInput> = {}): CardDiffInput {
  return {
    title: 'title',
    body: 'body',
    type: 'fact',
    cues: ['a', 'b'],
    confidence: 0.5,
    ...overrides,
  };
}

describe('diffCard', () => {
  it('reports no change for an identical card', () => {
    const diff = diffCard(card(), card());

    expect(diff.changed).toEqual([]);
    expect(diff.contentChanged).toBe(false);
  });

  it('reports a changed title as a content change', () => {
    const diff = diffCard(card(), card({ title: 'other' }));

    expect(diff.changed).toEqual(['title']);
    expect(diff.contentChanged).toBe(true);
  });

  it('reports a changed body as a content change', () => {
    const diff = diffCard(card(), card({ body: 'other' }));

    expect(diff.changed).toEqual(['body']);
    expect(diff.contentChanged).toBe(true);
  });

  it('reports changed cues as a content change', () => {
    const diff = diffCard(card(), card({ cues: ['a', 'c'] }));

    expect(diff.changed).toEqual(['cues']);
    expect(diff.contentChanged).toBe(true);
  });

  it('treats a changed type as a metadata change only', () => {
    const diff = diffCard(card(), card({ type: 'decision' }));

    expect(diff.changed).toEqual(['type']);
    expect(diff.contentChanged).toBe(false);
  });

  it('treats a changed confidence as a metadata change only', () => {
    const diff = diffCard(card(), card({ confidence: 0.9 }));

    expect(diff.changed).toEqual(['confidence']);
    expect(diff.contentChanged).toBe(false);
  });

  it('keeps the field order of the changed list', () => {
    const diff = diffCard(
      card(),
      card({
        title: 'other title',
        body: 'other body',
        type: 'insight',
        cues: ['z'],
        confidence: 0.1,
      })
    );

    // The order is written verbatim into activity_log.detail.
    expect(diff.changed).toEqual(['title', 'body', 'type', 'cues', 'confidence']);
    expect(diff.contentChanged).toBe(true);
  });

  it('reports a reordering of the cues as a content change', () => {
    const diff = diffCard(card({ cues: ['a', 'b'] }), card({ cues: ['b', 'a'] }));

    expect(diff.changed).toEqual(['cues']);
    expect(diff.contentChanged).toBe(true);
  });

  it('reports added and removed cues as a content change', () => {
    expect(diffCard(card({ cues: ['a'] }), card({ cues: ['a', 'b'] })).contentChanged).toBe(true);
    expect(diffCard(card({ cues: ['a', 'b'] }), card({ cues: ['a'] })).contentChanged).toBe(true);
    expect(diffCard(card({ cues: [] }), card({ cues: [] })).contentChanged).toBe(false);
  });

  it('reports several changes at once', () => {
    const diff = diffCard(card(), card({ title: 'other', confidence: 0.2 }));

    expect(diff.changed).toEqual(['title', 'confidence']);
    expect(diff.contentChanged).toBe(true);
  });
});

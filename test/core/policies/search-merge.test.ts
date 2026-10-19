import { describe, expect, it } from 'vitest';
import { mergeSearchResults } from '../../../src/core/policies/search-merge.js';
import { fakeCard, fakeHit } from '../../services/fakes.js';

describe('mergeSearchResults', () => {
  it('returns an empty list for two empty result sets', () => {
    expect(mergeSearchResults([], [], 10)).toEqual([]);
  });

  it('returns the primary hits when there is no secondary set', () => {
    const primary = [fakeHit(fakeCard({ id: 1 }), 0.9)];

    expect(mergeSearchResults(primary, [], 10)).toEqual(primary);
  });

  it('returns the secondary hits when there is no primary set', () => {
    const secondary = [fakeHit(fakeCard({ id: 2 }), 0.25, 'fallback')];

    expect(mergeSearchResults([], secondary, 10)).toEqual(secondary);
  });

  it('keeps the primary hits first and appends the secondary ones', () => {
    const primary = [fakeHit(fakeCard({ id: 1 }), 0.9), fakeHit(fakeCard({ id: 2 }), 0.8)];
    const secondary = [fakeHit(fakeCard({ id: 3 }), 0.25, 'fallback')];

    const merged = mergeSearchResults(primary, secondary, 10);

    expect(merged.map(hit => hit.card.id)).toEqual([1, 2, 3]);
    expect(merged.map(hit => hit.matchedBy)).toEqual(['fts', 'fts', 'fallback']);
  });

  it('lets the primary win a conflict on the card id', () => {
    const card = fakeCard({ id: 1 });
    const primary = [fakeHit(card, 0.9, 'semantic')];
    const secondary = [fakeHit(card, 0.25, 'fallback')];

    const merged = mergeSearchResults(primary, secondary, 10);

    expect(merged).toHaveLength(1);
    expect(merged[0].score).toBe(0.9);
    expect(merged[0].matchedBy).toBe('semantic');
  });

  it('never returns the same card twice', () => {
    const card = fakeCard({ id: 1 });
    const merged = mergeSearchResults(
      [fakeHit(card, 0.9), fakeHit(card, 0.5)],
      [fakeHit(card, 0.25, 'fallback')],
      10
    );

    expect(merged).toHaveLength(1);
  });

  it('cuts the result off at the limit', () => {
    const primary = [fakeHit(fakeCard({ id: 1 }), 0.9), fakeHit(fakeCard({ id: 2 }), 0.8)];
    const secondary = [fakeHit(fakeCard({ id: 3 }), 0.25, 'fallback')];

    const merged = mergeSearchResults(primary, secondary, 2);

    expect(merged.map(hit => hit.card.id)).toEqual([1, 2]);
  });

  it('cuts off before the secondary hits when the primary is already full', () => {
    const primary = [fakeHit(fakeCard({ id: 1 }), 0.9), fakeHit(fakeCard({ id: 2 }), 0.8)];
    const secondary = [fakeHit(fakeCard({ id: 3 }), 0.25, 'fallback')];

    const merged = mergeSearchResults(primary, secondary, 1);

    expect(merged.map(hit => hit.card.id)).toEqual([1]);
  });

  it('does not re-sort the hits', () => {
    // The scores are in descending order, but the merge must not touch
    // the order of the inputs.
    const primary = [fakeHit(fakeCard({ id: 1 }), 0.2), fakeHit(fakeCard({ id: 2 }), 0.9)];
    const secondary = [fakeHit(fakeCard({ id: 3 }), 0.5, 'fallback')];

    const merged = mergeSearchResults(primary, secondary, 10);

    expect(merged.map(hit => hit.card.id)).toEqual([1, 2, 3]);
    expect(merged.map(hit => hit.score)).toEqual([0.2, 0.9, 0.5]);
  });

  it('returns nothing for a limit of zero', () => {
    const primary = [fakeHit(fakeCard({ id: 1 }), 0.9)];

    expect(mergeSearchResults(primary, [], 0)).toEqual([]);
  });
});

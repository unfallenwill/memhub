import { describe, expect, it } from 'vitest';
import {
  CARD_STATUSES,
  CARD_TYPES,
  SEARCH_MODES,
  type ActivityActor,
  type CardStatus,
  type CardType,
  type EventType,
  type JobEventType,
  type MatchedBy,
  type SearchMode,
} from '../../../src/core/domain/types.js';

describe('core domain types', () => {
  it('exposes the supported card types', () => {
    expect(CARD_TYPES).toEqual(['fact', 'preference', 'decision', 'insight', 'pattern']);
    expect(CARD_TYPES).toHaveLength(5);
    expect(new Set(CARD_TYPES).size).toBe(CARD_TYPES.length);
  });

  it('exposes the card lifecycle statuses', () => {
    expect(CARD_STATUSES).toEqual(['active', 'archived', 'merged', 'rejected', 'superseded']);
    expect(CARD_STATUSES).toHaveLength(5);
    expect(new Set(CARD_STATUSES).size).toBe(CARD_STATUSES.length);
  });

  it('exposes the search modes', () => {
    expect(SEARCH_MODES).toEqual(['auto', 'semantic', 'keyword']);
    expect(SEARCH_MODES).toHaveLength(3);
    expect(new Set(SEARCH_MODES).size).toBe(SEARCH_MODES.length);
  });

  it('keeps the runtime const arrays frozen against accidental mutation', () => {
    // The tuples are declared with `as const`; copying them must not
    // affect the exported values.
    const copy = [...CARD_TYPES];
    copy.push('other' as CardType);
    expect(CARD_TYPES).toEqual(['fact', 'preference', 'decision', 'insight', 'pattern']);
  });

  it('derives the union types from the const arrays', () => {
    const type: CardType = 'fact';
    const status: CardStatus = 'active';
    const mode: SearchMode = 'auto';
    const matchedBy: MatchedBy = 'fts';
    const actor: ActivityActor = 'hook';
    const eventType: EventType = 'card.created';
    const jobType: JobEventType = 'job.compensation_scan';

    expect(type).toBe('fact');
    expect(status).toBe('active');
    expect(mode).toBe('auto');
    expect(matchedBy).toBe('fts');
    expect(actor).toBe('hook');
    expect(eventType).toBe('card.created');
    expect(jobType).toBe('job.compensation_scan');
  });

  it('lists the remaining match modes and actors', () => {
    const matched: MatchedBy[] = ['fts', 'cues', 'fallback', 'semantic'];
    const actors: ActivityActor[] = ['hook', 'worker', 'user:web', 'timer'];
    expect(matched).toHaveLength(4);
    expect(actors).toHaveLength(4);
  });
});

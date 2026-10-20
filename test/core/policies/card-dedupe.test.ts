import { describe, expect, it } from 'vitest';
import { isExactDuplicate } from '../../../src/core/policies/card-dedupe.js';

describe('isExactDuplicate', () => {
  it('matches a card with itself', () => {
    const card = { title: 'docker deploy', body: 'run the compose file' };
    expect(isExactDuplicate(card, card)).toBe(true);
  });

  it('matches two cards with the same title and body', () => {
    expect(isExactDuplicate({ title: 'a', body: 'b' }, { title: 'a', body: 'b' })).toBe(true);
  });

  it('does not match a different title', () => {
    expect(isExactDuplicate({ title: 'a', body: 'b' }, { title: 'A', body: 'b' })).toBe(false);
  });

  it('does not match a different body', () => {
    expect(isExactDuplicate({ title: 'a', body: 'b' }, { title: 'a', body: 'c' })).toBe(false);
  });

  it('is whitespace sensitive', () => {
    expect(isExactDuplicate({ title: 'a', body: 'b' }, { title: 'a', body: 'b ' })).toBe(false);
    expect(isExactDuplicate({ title: 'a', body: 'b' }, { title: ' a', body: 'b' })).toBe(false);
  });

  it('is case sensitive', () => {
    expect(isExactDuplicate({ title: 'Docker', body: 'b' }, { title: 'docker', body: 'b' })).toBe(
      false
    );
    expect(isExactDuplicate({ title: 'a', body: 'B' }, { title: 'a', body: 'b' })).toBe(false);
  });

  it('does not treat an empty title or body as equal to nothing else', () => {
    expect(isExactDuplicate({ title: '', body: '' }, { title: '', body: '' })).toBe(true);
    expect(isExactDuplicate({ title: '', body: '' }, { title: '', body: 'x' })).toBe(false);
  });
});

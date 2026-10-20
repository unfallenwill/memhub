import { describe, expect, it } from 'vitest';
import {
  CUES_SCORE,
  FALLBACK_SCORE,
  FTS_SCORE_WEIGHT,
  quoteFtsToken,
  tokenize,
} from '../../../src/core/search/tokenize.js';

describe('tokenize', () => {
  it('splits on whitespace, lowercases and drops empties', () => {
    expect(tokenize('  Hello   WORLD  ')).toEqual(['hello', 'world']);
  });

  it('returns nothing for an empty or blank query', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize('   ')).toEqual([]);
    expect(tokenize('\t\n ')).toEqual([]);
  });

  it('keeps punctuation inside the token', () => {
    expect(tokenize('docker-compose, ready!')).toEqual(['docker-compose,', 'ready!']);
  });
});

describe('quoteFtsToken', () => {
  it('wraps the token in double quotes', () => {
    expect(quoteFtsToken('docker')).toBe('"docker"');
  });

  it('escapes the double quotes of the token', () => {
    expect(quoteFtsToken('say "hi"')).toBe('"say ""hi"""');
  });

  it('makes an FTS-hostile token safe', () => {
    expect(quoteFtsToken('a OR b')).toBe('"a OR b"');
    expect(quoteFtsToken('*')).toBe('"*"');
  });
});

describe('the keyword scoring constants', () => {
  it('keeps the weights of the three arms', () => {
    expect(FTS_SCORE_WEIGHT).toBe(1);
    expect(CUES_SCORE).toBe(0.5);
    expect(FALLBACK_SCORE).toBe(0.25);
  });

  it('ranks the arms from the best to the worst match', () => {
    expect(FTS_SCORE_WEIGHT).toBeGreaterThan(CUES_SCORE);
    expect(CUES_SCORE).toBeGreaterThan(FALLBACK_SCORE);
  });
});

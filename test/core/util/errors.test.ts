import { describe, expect, it } from 'vitest';
import { errorMessage } from '../../../src/core/util/errors.js';

describe('errorMessage', () => {
  it('returns the message of an Error', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
  });

  it('returns the message of a subclass of Error', () => {
    class CustomError extends Error {}
    expect(errorMessage(new CustomError('custom'))).toBe('custom');
  });

  it('stringifies a thrown string', () => {
    expect(errorMessage('plain text')).toBe('plain text');
  });

  it('stringifies a thrown object', () => {
    expect(errorMessage({ code: 'nope' })).toBe('[object Object]');
  });

  it('stringifies null and undefined', () => {
    expect(errorMessage(null)).toBe('null');
    expect(errorMessage(undefined)).toBe('undefined');
  });

  it('stringifies a number', () => {
    expect(errorMessage(42)).toBe('42');
  });
});

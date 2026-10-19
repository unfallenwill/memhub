import { describe, expect, it } from 'vitest';
import { generateUserCode, normalizeUserCode } from '../../src/auth/device-grants.js';

/** Crockford base32 — no I/L/O/U to avoid transcription confusion. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

describe('user code', () => {
  describe('generateUserCode', () => {
    it('has the shape XXXX-XXXX', () => {
      for (let i = 0; i < 50; i++) {
        const code = generateUserCode();
        expect(code).toHaveLength(9);
        expect(code[4]).toBe('-');
        expect(code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
      }
    });

    it('uses only Crockford characters', () => {
      for (let i = 0; i < 50; i++) {
        for (const char of generateUserCode().replace('-', '')) {
          expect(CROCKFORD).toContain(char);
        }
      }
    });

    it('never emits the confusable characters I, L, O or U', () => {
      for (let i = 0; i < 200; i++) {
        expect(generateUserCode()).not.toMatch(/[ILOU]/);
      }
    });

    it('does not repeat itself', () => {
      const codes = new Set<string>();
      for (let i = 0; i < 200; i++) codes.add(generateUserCode());
      expect(codes.size).toBe(200);
    });
  });

  describe('normalizeUserCode', () => {
    it('round-trips a generated code', () => {
      for (let i = 0; i < 50; i++) {
        const code = generateUserCode();
        const normalized = normalizeUserCode(code);
        expect(normalized).not.toBeNull();
        expect(normalized).toBe(code.replace('-', ''));
        expect(normalizeUserCode(normalized!)).toBe(normalized);
      }
    });

    it('uppercases the input and drops the separator', () => {
      expect(normalizeUserCode('7q3k-m2xw')).toBe('7Q3KM2XW');
      expect(normalizeUserCode('7q3km2xw')).toBe('7Q3KM2XW');
    });

    it('drops other non-alphanumeric characters', () => {
      expect(normalizeUserCode('7Q3K M2XW')).toBe('7Q3KM2XW');
      expect(normalizeUserCode('7Q3K_M2XW')).toBe('7Q3KM2XW');
      expect(normalizeUserCode('7-Q3-K-M-2-X-W')).toBe('7Q3KM2XW');
    });

    it('maps the Crockford confusables I/L -> 1 and O -> 0', () => {
      expect(normalizeUserCode('ILILOO00')).toBe('11110000');
      expect(normalizeUserCode('ililoo00')).toBe('11110000');
    });

    it('returns null when the code is not 8 characters long', () => {
      expect(normalizeUserCode('')).toBeNull();
      expect(normalizeUserCode('7Q3K')).toBeNull();
      expect(normalizeUserCode('7Q3KM2XWZ')).toBeNull();
    });

    it('keeps a "U" (it is not part of the Crockford alphabet)', () => {
      // Documented quirk: normalization does not reject U, it only
      // remaps I/L/O. A stored code can never contain U, so such a
      // code never matches a grant.
      expect(normalizeUserCode('UUUUUUUU')).toBe('UUUUUUUU');
    });
  });
});

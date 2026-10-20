import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ensureSetupCodeFile,
  generateSetupCode,
  normalizeSetupCode,
  SETUP_CODE_PATTERN,
} from '../../src/auth/setup-code.js';

describe('setup code', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memhub-setup-'));
  const path = join(dir, 'setup-code');

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('generates codes matching the canonical pattern', () => {
    const codes = new Set<string>();
    for (let i = 0; i < 25; i++) {
      const code = generateSetupCode();
      expect(SETUP_CODE_PATTERN.test(code)).toBe(true);
      codes.add(code);
    }
    // Codes are random, not constant.
    expect(codes.size).toBeGreaterThan(1);
  });

  it('normalizes typed codes (case, separators)', () => {
    expect(normalizeSetupCode('ABC234-DEF567')).toBe('ABC234-DEF567');
    expect(normalizeSetupCode('abc234def567')).toBe('ABC234-DEF567');
    expect(normalizeSetupCode(' abc 234 def 567 ')).toBe('ABC234-DEF567');
    expect(normalizeSetupCode('')).toBeNull();
    expect(normalizeSetupCode('short')).toBeNull();
    expect(normalizeSetupCode('ABC234DEF5678')).toBeNull();
  });

  it('creates the file with mode 0600 and reuses the stored code', () => {
    const code = ensureSetupCodeFile(path);
    expect(SETUP_CODE_PATTERN.test(code)).toBe(true);
    expect(readFileSync(path, 'utf-8').trim()).toBe(code);
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    // A second call reuses the same code instead of rotating it.
    expect(ensureSetupCodeFile(path)).toBe(code);
  });

  it('regenerates when the stored content is not a valid code', () => {
    writeFileSync(path, 'garbage');
    const code = ensureSetupCodeFile(path);
    expect(SETUP_CODE_PATTERN.test(code)).toBe(true);
    expect(readFileSync(path, 'utf-8').trim()).toBe(code);
    if (process.platform !== 'win32') {
      // The mode is re-tightened even when the file already existed.
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
  });
});

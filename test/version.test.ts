import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { readVersion } from '../src/version.js';

describe('version', () => {
  const dirs: string[] = [];

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'memhub-version-'));
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it('reads the version from package.json in the base directory', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '9.9.9' }));
    expect(readVersion(dir)).toBe('9.9.9');
  });

  it('looks one level up (sources layout)', () => {
    const root = tempDir();
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '1.2.3' }));
    expect(readVersion(join(root, 'src'))).toBe('1.2.3');
  });

  it('looks two levels up (dist layout)', () => {
    const root = tempDir();
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '4.5.6' }));
    expect(readVersion(join(root, 'dist', 'src'))).toBe('4.5.6');
  });

  it('falls back to 0.0.0 when package.json is missing', () => {
    const dir = tempDir();
    expect(readVersion(join(dir, 'nowhere'))).toBe('0.0.0');
  });

  it('falls back to 0.0.0 when package.json is malformed', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'package.json'), '{not json');
    expect(readVersion(dir)).toBe('0.0.0');
  });

  it('falls back to 0.0.0 when the version field is missing or empty', () => {
    const noVersion = tempDir();
    writeFileSync(join(noVersion, 'package.json'), JSON.stringify({ name: 'x' }));
    expect(readVersion(noVersion)).toBe('0.0.0');

    const emptyVersion = tempDir();
    writeFileSync(join(emptyVersion, 'package.json'), JSON.stringify({ version: '' }));
    expect(readVersion(emptyVersion)).toBe('0.0.0');
  });

  it('skips a malformed package.json and tries the next candidate', () => {
    const root = tempDir();
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'package.json'), 'broken');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '7.7.7' }));
    expect(readVersion(join(root, 'src'))).toBe('7.7.7');
  });
});

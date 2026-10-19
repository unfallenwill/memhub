import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadOrCreateToken,
  readToken,
  resolveExistingToken,
  resolveToken,
  TOKEN_ENV,
} from '../../src/daemon/token.js';

describe('token', () => {
  const dirs: string[] = [];

  function tokenPath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'memhub-token-'));
    dirs.push(dir);
    return join(dir, 'token');
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it('creates a random token on first use and reuses it afterwards', () => {
    const path = tokenPath();
    const first = loadOrCreateToken(path);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(path, 'utf-8').trim()).toBe(first);

    const second = loadOrCreateToken(path);
    expect(second).toBe(first);
  });

  it('replaces an empty token file', () => {
    const path = tokenPath();
    writeFileSync(path, '   \n');
    const token = loadOrCreateToken(path);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('re-tightens the mode when regenerating into a pre-existing file', () => {
    const path = tokenPath();
    if (process.platform !== 'win32') {
      writeFileSync(path, '', { mode: 0o644 });
      chmodSync(path, 0o644);
      loadOrCreateToken(path);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
  });

  it('readToken returns null when the file is missing or empty', () => {
    expect(readToken(join('Z:', 'definitely', 'missing'))).toBeNull();
    const path = tokenPath();
    writeFileSync(path, '');
    expect(readToken(path)).toBeNull();
  });
});

describe('token env override', () => {
  const dirs: string[] = [];

  function tokenPath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'memhub-token-env-'));
    dirs.push(dir);
    return join(dir, 'token');
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it('resolveToken prefers MEMHUB_TOKEN and never writes the file', () => {
    vi.stubEnv(TOKEN_ENV, 'env-token');
    const path = tokenPath();
    expect(resolveToken(path)).toBe('env-token');
    expect(existsSync(path)).toBe(false);
  });

  it('resolveToken falls back to the token file', () => {
    const path = tokenPath();
    const created = loadOrCreateToken(path);
    expect(resolveToken(path)).toBe(created);
  });

  it('resolveToken ignores a blank MEMHUB_TOKEN', () => {
    vi.stubEnv(TOKEN_ENV, '   ');
    const path = tokenPath();
    expect(resolveToken(path)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('resolveExistingToken prefers MEMHUB_TOKEN without a file', () => {
    vi.stubEnv(TOKEN_ENV, 'env-token');
    expect(resolveExistingToken(tokenPath())).toBe('env-token');
  });

  it('resolveExistingToken falls back to the file and null', () => {
    const path = tokenPath();
    expect(resolveExistingToken(path)).toBeNull();
    const created = loadOrCreateToken(path);
    expect(resolveExistingToken(path)).toBe(created);
  });
});

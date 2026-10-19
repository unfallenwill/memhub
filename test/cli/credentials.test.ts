import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  statSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runLogoutCommand } from '../../src/cli/logout.js';
import {
  deleteCredentials,
  normalizeBaseUrl,
  readCredentials,
  resolveRemoteToken,
  writeCredentials,
} from '../../src/cli/credentials.js';
import { readConfig, writeConfig } from '../../src/cli/config-file.js';
import { getCredentialsPath, getMemhubHome } from '../../src/paths.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('credentials store', () => {
  const dirs: string[] = [];
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'memhub-creds-'));
    dirs.push(home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  describe('normalizeBaseUrl', () => {
    it('accepts http(s) origins and strips paths', () => {
      expect(normalizeBaseUrl('https://x.example')).toBe('https://x.example');
      expect(normalizeBaseUrl('http://127.0.0.1:7800/')).toBe('http://127.0.0.1:7800');
      expect(normalizeBaseUrl('https://x.example/sub')).toBe('https://x.example');
    });

    it('rejects other schemes, credentials and garbage', () => {
      expect(normalizeBaseUrl('ftp://x.example')).toBeNull();
      expect(normalizeBaseUrl('https://user:pw@x.example')).toBeNull();
      expect(normalizeBaseUrl('not a url')).toBeNull();
      expect(normalizeBaseUrl('')).toBeNull();
    });
  });

  it('writes, reads and deletes credentials', () => {
    expect(readCredentials(home)).toBeNull();
    writeCredentials(home, { version: 1, url: 'https://x.example', token: 't'.repeat(64) });
    expect(readCredentials(home)).toEqual({
      version: 1,
      url: 'https://x.example',
      token: 't'.repeat(64),
    });
    expect(JSON.parse(readFileSync(getCredentialsPath(home), 'utf-8')).version).toBe(1);
    if (process.platform !== 'win32') {
      expect(statSync(getCredentialsPath(home)).mode & 0o777).toBe(0o600);
    }
    expect(deleteCredentials(home)).toBe(true);
    expect(deleteCredentials(home)).toBe(false);
    expect(readCredentials(home)).toBeNull();
  });

  it('re-tightens the mode when rewriting a loosened credentials file', () => {
    const path = getCredentialsPath(home);
    writeCredentials(home, { version: 1, url: 'https://x.example', token: 'a'.repeat(64) });
    if (process.platform !== 'win32') {
      chmodSync(path, 0o644);
    }
    writeCredentials(home, { version: 1, url: 'https://y.example', token: 'b'.repeat(64) });
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    expect(readCredentials(home)?.url).toBe('https://y.example');
  });

  it('treats malformed credentials files as absent', () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(getCredentialsPath(home), 'not json', 'utf-8');
    expect(readCredentials(home)).toBeNull();
    writeFileSync(getCredentialsPath(home), JSON.stringify({ version: 2, url: 'x', token: 'y' }));
    expect(readCredentials(home)).toBeNull();
  });

  describe('resolveRemoteToken', () => {
    it('prefers MEMHUB_TOKEN over the file', () => {
      vi.stubEnv('MEMHUB_TOKEN', 'env-token');
      writeCredentials(home, { version: 1, url: 'https://x.example', token: 'file-token' });
      expect(resolveRemoteToken('https://x.example', home)).toEqual({ token: 'env-token' });
    });

    it('uses the file when the URL matches', () => {
      writeCredentials(home, { version: 1, url: 'https://x.example', token: 'file-token' });
      expect(resolveRemoteToken('https://x.example', home)).toEqual({ token: 'file-token' });
    });

    it('errors for a different URL', () => {
      writeCredentials(home, { version: 1, url: 'https://x.example', token: 'file-token' });
      expect(resolveRemoteToken('https://other.example', home)).toEqual({
        error: 'not logged in to https://other.example',
      });
    });
  });
});

describe('runLogoutCommand', () => {
  const dirs: string[] = [];
  let home: string;
  let logs: string[];
  let errors: string[];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'memhub-logout-'));
    dirs.push(home);
    logs = [];
    errors = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => logs.push(args.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) =>
      errors.push(args.join(' '))
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it('exits 0 when not logged in', async () => {
    expect(await runLogoutCommand({ home })).toBe(0);
    expect(logs.join('\n')).toContain('Not logged in');
  });

  it('revokes and deletes on success', async () => {
    writeCredentials(home, { version: 1, url: 'https://x.example', token: 't'.repeat(64) });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ ok: true }))
    );
    expect(await runLogoutCommand({ home })).toBe(0);
    expect(readCredentials(home)).toBeNull();
    expect(logs.join('\n')).toContain('Logged out from https://x.example');
  });

  it('unsets the configured default base-url when it matched', async () => {
    writeCredentials(home, { version: 1, url: 'https://x.example', token: 't'.repeat(64) });
    writeConfig(home, { version: 1, base_url: 'https://x.example' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ ok: true }))
    );
    expect(await runLogoutCommand({ home })).toBe(0);
    expect(readConfig(home)).toEqual({ version: 1 });
    expect(logs.join('\n')).toContain('Unset the default base-url');
  });

  it('keeps the configured base-url when it points elsewhere', async () => {
    writeCredentials(home, { version: 1, url: 'https://x.example', token: 't'.repeat(64) });
    writeConfig(home, { version: 1, base_url: 'https://other.example' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ ok: true }))
    );
    expect(await runLogoutCommand({ home })).toBe(0);
    expect(readConfig(home).base_url).toBe('https://other.example');
  });

  it('keeps the config when the server is unreachable', async () => {
    writeCredentials(home, { version: 1, url: 'https://x.example', token: 't'.repeat(64) });
    writeConfig(home, { version: 1, base_url: 'https://x.example' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      })
    );
    expect(await runLogoutCommand({ home })).toBe(1);
    expect(readConfig(home).base_url).toBe('https://x.example');
  });

  it('still deletes the file when the token was already invalid', async () => {
    writeCredentials(home, { version: 1, url: 'https://x.example', token: 't'.repeat(64) });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: { code: 'unauthorized', message: 'no' } }, 401))
    );
    expect(await runLogoutCommand({ home })).toBe(0);
    expect(readCredentials(home)).toBeNull();
    expect(logs.join('\n')).toContain('already invalid');
  });

  it('keeps the file when the server is unreachable', async () => {
    writeCredentials(home, { version: 1, url: 'https://x.example', token: 't'.repeat(64) });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      })
    );
    expect(await runLogoutCommand({ home })).toBe(1);
    expect(readCredentials(home)).not.toBeNull();
    expect(errors.join('\n')).toContain('kept');
  });
});

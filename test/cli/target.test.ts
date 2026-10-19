import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveCommandTarget } from '../../src/cli/target.js';
import { writeCredentials } from '../../src/cli/credentials.js';
import { writeConfig } from '../../src/cli/config-file.js';

describe('resolveCommandTarget', () => {
  let home: string;
  const dirs: string[] = [];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'memhub-target-'));
    dirs.push(home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  function localToken(token = 'local-token'): void {
    writeFileSync(join(home, 'token'), token);
  }

  function loggedIn(url = 'https://x.example'): void {
    writeCredentials(home, { version: 1, url, token: 'device-token' });
  }

  it('sends an explicit --base-url to the remote daemon', () => {
    loggedIn();
    expect(resolveCommandTarget({ url: 'https://x.example/sub', port: 7800, home })).toEqual({
      kind: 'remote',
      baseUrl: 'https://x.example',
      token: 'device-token',
    });
  });

  it('rejects an invalid explicit --base-url', () => {
    expect(resolveCommandTarget({ url: 'nonsense', port: 7800, home })).toEqual({
      kind: 'error',
      message: 'invalid --base-url value: nonsense',
    });
  });

  it('tells the user to log in when the flag has no credentials', () => {
    expect(resolveCommandTarget({ url: 'https://x.example', port: 7800, home })).toEqual({
      kind: 'error',
      message:
        'not logged in to https://x.example — run: memhub login --base-url https://x.example',
    });
  });

  it('routes to the configured remote when no flag is given', () => {
    loggedIn();
    writeConfig(home, { version: 1, base_url: 'https://x.example' });
    expect(resolveCommandTarget({ port: 7800, home })).toEqual({
      kind: 'remote',
      baseUrl: 'https://x.example',
      token: 'device-token',
    });
  });

  it('errors on the configured remote when logged in elsewhere', () => {
    loggedIn('https://other.example');
    writeConfig(home, { version: 1, base_url: 'https://x.example' });
    const target = resolveCommandTarget({ port: 7800, home });
    expect(target.kind).toBe('error');
    if (target.kind === 'error') {
      expect(target.message).toContain('not logged in to https://x.example');
    }
  });

  it('an explicit --port forces the local daemon over config', () => {
    loggedIn();
    writeConfig(home, { version: 1, base_url: 'https://x.example' });
    localToken();
    expect(resolveCommandTarget({ port: 7900, portSet: true, home })).toEqual({
      kind: 'local',
      port: 7900,
      token: 'local-token',
    });
  });

  it('falls back to the local daemon without config', () => {
    localToken();
    expect(resolveCommandTarget({ port: 7800, home })).toEqual({
      kind: 'local',
      port: 7800,
      token: 'local-token',
    });
  });

  it('errors locally without a token file', () => {
    expect(resolveCommandTarget({ port: 7800, home })).toEqual({
      kind: 'error',
      message: 'No MemHub token found — start the daemon first: memhub server',
    });
  });

  it('errors on a corrupted configured base_url instead of falling back', () => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ version: 1, base_url: '::bad::' }));
    expect(resolveCommandTarget({ port: 7800, home })).toEqual({
      kind: 'error',
      message: 'invalid base-url in config — run: memhub config set base-url <url>',
    });
  });

  it('MEMHUB_TOKEN wins over the stored device token', () => {
    vi.stubEnv('MEMHUB_TOKEN', 'env-token');
    loggedIn();
    expect(resolveCommandTarget({ url: 'https://x.example', port: 7800, home })).toEqual({
      kind: 'remote',
      baseUrl: 'https://x.example',
      token: 'env-token',
    });
  });
});

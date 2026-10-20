/**
 * The failure paths of `memhub logout` (src/cli/commands/logout.ts).
 *
 * The happy path is covered by the existing logout test. This file
 * covers the branches that decide what happens to the configured
 * default base-url: a config that cannot be read, a config that holds
 * an invalid base-url, and a daemon that answers with an unexpected
 * status.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runLogoutCommand } from '../../../src/cli/commands/logout.js';
import { getConfigPath } from '../../../src/config/paths.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('runLogoutCommand', () => {
  const dirs: string[] = [];
  let home: string;
  let logs: string[];
  let errors: string[];

  function tempHome(): string {
    const dir = mkdtempSync(join(tmpdir(), 'memhub-logout-'));
    dirs.push(dir);
    return dir;
  }

  function writeCredentials(url: string, token: string): void {
    writeFileSync(join(home, 'credentials.json'), JSON.stringify({ version: 1, url, token }));
  }

  function writeConfig(baseUrl: string): void {
    writeFileSync(getConfigPath(home), JSON.stringify({ version: 1, base_url: baseUrl }));
  }

  beforeEach(() => {
    home = tempHome();
    logs = [];
    errors = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.join(' '));
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it('reports a daemon that answers with an unexpected status', async () => {
    writeCredentials('https://x.example', 'token');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: 'boom' }, 500))
    );

    const code = await runLogoutCommand({ home });

    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('Logout failed (HTTP 500)');
  });

  it('keeps the credentials when the daemon cannot be reached', async () => {
    writeCredentials('https://x.example', 'token');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      })
    );

    const code = await runLogoutCommand({ home });

    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('the credentials were kept');
  });

  it('unsets an invalid configured base-url', async () => {
    writeCredentials('https://x.example', 'token');
    writeConfig('not a url');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ ok: true }))
    );

    const code = await runLogoutCommand({ home });

    expect(code).toBe(0);
    expect(logs.join('\n')).toContain('Unset the invalid default base-url (was not a url)');
  });

  it('leaves a broken config alone', async () => {
    writeCredentials('https://x.example', 'token');
    writeFileSync(getConfigPath(home), '{ not json');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ ok: true }))
    );

    const code = await runLogoutCommand({ home });

    // The logout itself succeeds; the broken config is reported by `add`.
    expect(code).toBe(0);
    expect(logs.join('\n')).not.toContain('Unset the default base-url');
  });

  it('survives a broken config when nothing is logged in', async () => {
    writeFileSync(getConfigPath(home), '{ not json');

    const code = await runLogoutCommand({ home });

    expect(code).toBe(0);
    expect(logs.join('\n')).toContain('Not logged in.');
  });

  it('reports the leftover default base-url when nothing is logged in', async () => {
    writeConfig('https://x.example');

    const code = await runLogoutCommand({ home });

    expect(code).toBe(0);
    expect(logs.join('\n')).toContain('the default base-url is still https://x.example');
  });

  it('treats an already invalid token as logged out', async () => {
    writeCredentials('https://x.example', 'token');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: 'invalid_token' }, 401))
    );

    const code = await runLogoutCommand({ home });

    expect(code).toBe(0);
    expect(logs.join('\n')).toContain('the stored token was already invalid there');
  });

  it('resolves the home directory from the environment when none is given', async () => {
    const fallback = tempHome();
    vi.stubEnv('MEMHUB_HOME', fallback);

    const code = await runLogoutCommand();

    expect(code).toBe(0);
    expect(logs.join('\n')).toContain('Not logged in.');
  });
});

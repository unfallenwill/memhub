/**
 * The failure paths of `memhub login` (src/cli/commands/login.ts).
 *
 * The happy path is covered by test/cli/commands/login.test.ts. This
 * file covers the branches that end the login early: a broken config, a
 * daemon that is not a MemHub daemon, every non-granted outcome of the
 * device flow and a token that does not survive the verification call.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runLoginCommand } from '../../../src/cli/commands/login.js';

const HEALTH = {
  app: 'memhub',
  pid: 1,
  uptime: 5,
  version: '9.9.9',
  cards: { total: 0, active: 0, pending_index: 0 },
  queue: { pending_events: 0, oldest_unindexed_event_age_s: 0 },
  index: { ready: false, model: null },
};

const GRANT = {
  device_code: 'd'.repeat(64),
  user_code: 'ABCD-1234',
  verification_uri: 'https://x.example/login',
  verification_uri_complete: 'https://x.example/login?code=ABCD-1234',
  expires_in: 300,
  interval: 0,
  requires_setup: false,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('runLoginCommand failure paths', () => {
  const dirs: string[] = [];
  let home: string;
  let errors: string[];

  function tempHome(): string {
    const dir = mkdtempSync(join(tmpdir(), 'memhub-login-fail-'));
    dirs.push(dir);
    return dir;
  }

  beforeEach(() => {
    home = tempHome();
    errors = [];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.join(' '));
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it('reports a broken config file and stops', async () => {
    writeFileSync(join(home, 'config.json'), '{ not json');

    const code = await runLoginCommand({ url: 'https://x.example', home });

    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('is unreadable');
  });

  it('uses the global fetch when no implementation is injected', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    vi.stubGlobal('fetch', fetchMock);

    const code = await runLoginCommand({ url: 'https://x.example', home });

    expect(code).toBe(1);
    expect(fetchMock).toHaveBeenCalled();
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain('/healthz');
  });

  it('hints at the Host header when another program answers', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ app: 'other' }));

    const code = await runLoginCommand({
      url: 'https://x.example',
      home,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('Cannot reach a MemHub daemon');
    expect(errors.join('\n')).toContain('MEMHUB_ALLOWED_HOSTS');
  });

  it('reports a refused device-code request', async () => {
    const fetchImpl = vi.fn(async (input: string) => {
      const url = String(input);
      if (url.endsWith('/healthz')) return jsonResponse(HEALTH);
      return jsonResponse({ error: 'invalid_client' }, 403);
    });

    const code = await runLoginCommand({
      url: 'https://x.example',
      home,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      open: () => false,
      sleep: async () => {},
    });

    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('The daemon refused the login request (HTTP 403)');
  });

  it('reports a denied login', async () => {
    const fetchImpl = vi.fn(async (input: string) => {
      const url = String(input);
      if (url.endsWith('/healthz')) return jsonResponse(HEALTH);
      if (url.endsWith('/oauth/device/code')) return jsonResponse(GRANT);
      return jsonResponse({ error: 'access_denied' }, 400);
    });

    const code = await runLoginCommand({
      url: 'https://x.example',
      home,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      open: () => false,
      sleep: async () => {},
    });

    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('The login was denied');
  });

  it('reports a rejected token request', async () => {
    const fetchImpl = vi.fn(async (input: string) => {
      const url = String(input);
      if (url.endsWith('/healthz')) return jsonResponse(HEALTH);
      if (url.endsWith('/oauth/device/code')) return jsonResponse(GRANT);
      return jsonResponse({ error: 'invalid_grant' }, 400);
    });

    const code = await runLoginCommand({
      url: 'https://x.example',
      home,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      open: () => false,
      sleep: async () => {},
    });

    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('The daemon rejected the token request (HTTP 400)');
  });

  it('reports a timeout when the user never approves', async () => {
    const fetchImpl = vi.fn(async (input: string) => {
      const url = String(input);
      if (url.endsWith('/healthz')) return jsonResponse(HEALTH);
      if (url.endsWith('/oauth/device/code')) return jsonResponse(GRANT);
      return jsonResponse({ error: 'authorization_pending' }, 400);
    });
    // The clock jumps past the expiry on every call, so the flow gives up.
    let tick = 0;
    const now = (): number => {
      tick += 100_000;
      return tick;
    };

    const code = await runLoginCommand({
      url: 'https://x.example',
      home,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      open: () => false,
      sleep: async () => {},
      now,
    });

    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('Timed out waiting for authorization');
  });

  it('refuses to save a token that does not survive the verification', async () => {
    const fetchImpl = vi.fn(async (input: string) => {
      const url = String(input);
      if (url.endsWith('/healthz')) return jsonResponse(HEALTH);
      if (url.endsWith('/oauth/device/code')) return jsonResponse(GRANT);
      if (url.endsWith('/oauth/device/token')) {
        return jsonResponse({ access_token: 't'.repeat(64), token_type: 'Bearer' });
      }
      // The verification call fails.
      return jsonResponse({ error: 'nope' }, 403);
    });

    const code = await runLoginCommand({
      url: 'https://x.example',
      home,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      open: () => false,
      sleep: async () => {},
    });

    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('does not work — refusing to save it');
  });
});

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runLoginCommand, parseLoginArgs } from '../../src/cli/login.js';
import { getCredentialsPath } from '../../src/paths.js';

const HEALTH = {
  app: 'memhub',
  pid: 1,
  uptime: 5,
  version: '9.9.9',
  cards: { total: 0, active: 0, pending_index: 0 },
  queue: { pending_events: 0, oldest_unindexed_event_age_s: 0 },
  index: { ready: false, model: null },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('parseLoginArgs', () => {
  it('parses --base-url and allows omitting it', () => {
    expect(parseLoginArgs(['--base-url', 'https://x.example']).url).toBe('https://x.example');
    expect(parseLoginArgs([]).url).toBeUndefined();
  });

  it('rejects bare positional arguments with the new syntax', () => {
    expect(() => parseLoginArgs(['https://x.example'])).toThrow('--base-url');
    expect(() => parseLoginArgs(['--nope'])).toThrow('unexpected argument');
  });
});

describe('runLoginCommand', () => {
  const dirs: string[] = [];
  let home: string;
  let logs: string[];
  let errors: string[];

  function tempHome(): string {
    const dir = mkdtempSync(join(tmpdir(), 'memhub-login-'));
    dirs.push(dir);
    return dir;
  }

  beforeEach(() => {
    home = tempHome();
    logs = [];
    errors = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => logs.push(args.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) =>
      errors.push(args.join(' '))
    );
    vi.stubGlobal('sleep', undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it('rejects an invalid URL before any request', async () => {
    const code = await runLoginCommand({ url: 'not a url', home });
    expect(code).toBe(1);
    expect(errors[0]).toContain('Invalid server URL');
  });

  it('prints usage when no URL is given and none is configured', async () => {
    const code = await runLoginCommand({ home });
    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('usage: memhub login --base-url <url>');
  });

  it('falls back to the configured base-url when no URL is given', async () => {
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ version: 1, base_url: 'https://x.example' })
    );
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const code = await runLoginCommand({ home, fetchImpl });
    expect(code).toBe(1);
    const requested = String((fetchImpl.mock.calls[0] as unknown[])[0]);
    expect(requested).toContain('https://x.example/healthz');
  });

  it('blames the config when the configured base-url is invalid', async () => {
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ version: 1, base_url: 'memhub.example.com' })
    );
    const code = await runLoginCommand({ home, fetchImpl: vi.fn(async () => jsonResponse({})) });
    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('Invalid base-url in the config');
    expect(errors.join('\n')).toContain('memhub config set base-url');
  });

  it('warns when logging in to a server other than the configured default', async () => {
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ version: 1, base_url: 'https://old.example' })
    );
    let pollCount = 0;
    const fetchImpl = vi.fn(async (input: string) => {
      const url = String(input);
      if (url.endsWith('/healthz')) return jsonResponse(HEALTH);
      if (url.endsWith('/oauth/device/code')) {
        return jsonResponse({
          device_code: 'd'.repeat(64),
          user_code: 'ABCD-1234',
          verification_uri: 'https://new.example/login',
          verification_uri_complete: 'https://new.example/login?code=ABCD-1234',
          expires_in: 300,
          interval: 5,
          requires_setup: false,
        });
      }
      if (url.endsWith('/oauth/device/token')) {
        pollCount += 1;
        if (pollCount === 1) return jsonResponse({ error: 'authorization_pending' }, 400);
        return jsonResponse({ access_token: 't'.repeat(64), token_type: 'Bearer' });
      }
      if (url.endsWith('/api/queue')) return jsonResponse({ pending_events: 0 });
      throw new Error(`unexpected url: ${url}`);
    });
    const code = await runLoginCommand({
      url: 'https://new.example',
      home,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      open: () => false,
      sleep: async () => {},
    });
    expect(code).toBe(0);
    expect(logs.join('\n')).toContain('default base-url is still https://old.example');
    expect(logs.join('\n')).toContain('memhub config set base-url https://new.example');
  });

  it('exits 1 when the server is unreachable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const code = await runLoginCommand({ url: 'https://down.example', home, fetchImpl });
    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('Cannot reach');
  });

  it('runs the flow: code, browser, poll, verify, persist', async () => {
    let pollCount = 0;
    const fetchImpl = vi.fn(async (input: string) => {
      const url = String(input);
      if (url.endsWith('/healthz')) return jsonResponse(HEALTH);
      if (url.endsWith('/oauth/device/code')) {
        return jsonResponse({
          device_code: 'd'.repeat(64),
          user_code: 'ABCD-1234',
          verification_uri: 'https://x.example/login',
          verification_uri_complete: 'https://x.example/login?code=ABCD-1234',
          expires_in: 300,
          interval: 5,
          requires_setup: true,
        });
      }
      if (url.endsWith('/oauth/device/token')) {
        pollCount += 1;
        if (pollCount === 1) {
          return jsonResponse({ error: 'authorization_pending' }, 400);
        }
        return jsonResponse({ access_token: 't'.repeat(64), token_type: 'Bearer' });
      }
      if (url.endsWith('/api/queue')) return jsonResponse({ pending_events: 0 });
      throw new Error(`unexpected url: ${url}`);
    });
    const open = vi.fn(() => true);
    const sleep = vi.fn(async () => {});

    const code = await runLoginCommand({
      url: 'https://x.example',
      home,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      open,
      sleep,
    });

    expect(code).toBe(0);
    expect(open).toHaveBeenCalledWith('https://x.example/login?code=ABCD-1234');
    expect(logs.join('\n')).toContain('ABCD-1234');
    expect(logs.join('\n')).toContain('no admin password yet');
    expect(logs.join('\n')).toContain('Logged in to https://x.example');
    expect(logs.join('\n')).toContain('memhub config set base-url https://x.example');
    const stored = JSON.parse(readFileSync(getCredentialsPath(home), 'utf-8')) as {
      url: string;
      token: string;
    };
    expect(stored).toEqual({ version: 1, url: 'https://x.example', token: 't'.repeat(64) });
    if (process.platform !== 'win32') {
      // 0600 permissions are a POSIX concept; Windows ignores the mode.
      expect(statSync(getCredentialsPath(home)).mode & 0o777).toBe(0o600);
    }
  });

  it('reports browser fallback when opening fails', async () => {
    const fetchImpl = vi.fn(async (input: string) => {
      const url = String(input);
      if (url.endsWith('/healthz')) return jsonResponse(HEALTH);
      if (url.endsWith('/oauth/device/code')) {
        return jsonResponse({
          device_code: 'd'.repeat(64),
          user_code: 'ABCD-1234',
          verification_uri: 'https://x.example/login',
          verification_uri_complete: 'https://x.example/login?code=ABCD-1234',
          expires_in: 300,
          interval: 5,
          requires_setup: false,
        });
      }
      return jsonResponse({ error: 'expired_token' }, 400);
    });
    const code = await runLoginCommand({
      url: 'https://x.example',
      home,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      open: () => false,
      sleep: async () => {},
    });
    expect(code).toBe(1);
    expect(logs.join('\n')).toContain('no browser could be opened');
    expect(errors.join('\n')).toContain('expired');
    expect(existsSync(getCredentialsPath(home))).toBe(false);
  });

  it('increases the interval on slow_down', async () => {
    const intervals: number[] = [];
    let polls = 0;
    const fetchImpl = vi.fn(async (input: string) => {
      const url = String(input);
      if (url.endsWith('/healthz')) return jsonResponse(HEALTH);
      if (url.endsWith('/oauth/device/code')) {
        return jsonResponse({
          device_code: 'd'.repeat(64),
          user_code: 'ABCD-1234',
          verification_uri: 'https://x.example/login',
          verification_uri_complete: 'https://x.example/login?code=ABCD-1234',
          expires_in: 300,
          interval: 5,
          requires_setup: false,
        });
      }
      if (url.endsWith('/oauth/device/token')) {
        polls += 1;
        // Two slow_down responses, then give up so the test finishes fast.
        return polls <= 2
          ? jsonResponse({ error: 'slow_down' }, 400)
          : jsonResponse({ error: 'expired_token' }, 400);
      }
      throw new Error('unexpected');
    });
    const sleep = vi.fn(async (ms: number) => {
      intervals.push(ms);
    });
    await runLoginCommand({
      url: 'https://x.example',
      home,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      open: () => false,
      sleep,
    });
    // First sleep uses the advertised interval, later ones grow by 5s.
    expect(intervals).toEqual([5000, 10000, 15000]);
  });
});

/**
 * The configuration lookup of `memhub login` (src/cli/commands/login.ts).
 *
 * The command reads the default base-url from the config file of the
 * data directory. The directory comes from the caller or from the
 * environment, a broken config file is reported instead of being
 * ignored, and a machine that cannot tell who the user is still logs in
 * with a generic device label.
 */

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('os', async importOriginal => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    // A machine without a passwd entry cannot name the user.
    userInfo: () => {
      throw new Error('uv_os_get_passwd failed');
    },
  };
});

const healthBody = {
  app: 'memhub',
  pid: 777,
  uptime: 42,
  version: '1.0.0',
  cards: { total: 3, active: 2, pending_index: 1 },
  queue: { pending_events: 1, oldest_unindexed_age_s: 5 },
  index: { ready: false, model: null },
};

describe('the configuration of memhub login', () => {
  const homes: string[] = [];

  beforeEach(() => {
    const home = mkdtempSync(join(tmpdir(), 'memhub-login-config-'));
    homes.push(home);
    vi.stubEnv('MEMHUB_HOME', home);
  });

  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('../../../src/cli/config-file.js');
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    for (const home of homes.splice(0)) {
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it('takes the data directory from the environment when none is given', async () => {
    const { runLoginCommand } = await import('../../../src/cli/commands/login.js');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });

    const code = await runLoginCommand({
      url: 'https://x.example',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      open: () => true,
    });

    expect(code).toBe(1);
    expect(error.mock.calls.flat().join('\n')).toContain('Cannot reach a MemHub daemon');
  });

  it('reports a config file that cannot be read', async () => {
    vi.doMock('../../../src/cli/config-file.js', () => ({
      readConfig: () => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw 'the config file is on fire';
      },
    }));
    const { runLoginCommand } = await import('../../../src/cli/commands/login.js');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const code = await runLoginCommand({ url: 'https://x.example', home: homes[0] });

    expect(code).toBe(1);
    expect(error.mock.calls.flat().join('\n')).toContain('the config file is on fire');
  });

  it('labels the device generically when the user cannot be determined', async () => {
    const { runLoginCommand } = await import('../../../src/cli/commands/login.js');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetchImpl = vi.fn(async (input: string) => {
      if (String(input).endsWith('/healthz')) {
        return new Response(JSON.stringify(healthBody), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'invalid_client' }), { status: 403 });
    });

    const code = await runLoginCommand({
      url: 'https://x.example',
      home: homes[0],
      fetchImpl: fetchImpl as unknown as typeof fetch,
      open: () => true,
    });

    expect(code).toBe(1);
    const request = fetchImpl.mock.calls.find(call =>
      String(call[0]).endsWith('/oauth/device/code')
    );
    expect(request).toBeDefined();
    const body = JSON.parse(String((request as unknown as [string, RequestInit])[1].body)) as {
      label: string;
    };
    expect(body.label).toBe('cli');
  });
});

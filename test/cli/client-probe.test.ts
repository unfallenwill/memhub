/**
 * The health probe of the CLI (src/cli/client.ts) and the remote client
 * (src/cli/http/client.ts).
 *
 * Something that answers on the port but is not a MemHub daemon must be
 * reported as "other", and a remote client without an injected fetch
 * falls back to the global one.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeHealthzUrl } from '../../src/cli/client.js';
import { RemoteDaemonClient } from '../../src/cli/http/client.js';

describe('the health probe of the CLI', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('reports a body that cannot be read as another program', async () => {
    const fetchImpl = vi.fn(
      async () =>
        ({
          status: 200,
          text: async () => {
            throw new Error('the connection broke while reading');
          },
        }) as unknown as Response
    );

    const probe = await probeHealthzUrl(
      'https://x.example',
      1000,
      fetchImpl as unknown as typeof fetch
    );

    expect(probe).toEqual({ kind: 'other' });
  });
});

describe('the remote client of the CLI', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shuts the daemon down with the global fetch when none is injected', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new RemoteDaemonClient('https://x.example', 'device-token');

    expect(await client.shutdown()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://x.example/api/shutdown');
    expect(new Headers(init.headers).get('x-memhub-token')).toBe('device-token');
  });
});

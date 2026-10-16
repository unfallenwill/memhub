import { afterEach, describe, expect, it, vi } from 'vitest';
import { postShutdown, probeHealthz } from '../../src/cli/client.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const healthBody = {
  app: 'memhub',
  pid: 123,
  uptime: 10,
  version: '1.0.0',
  cards: { total: 1, active: 1, pending_index: 0 },
  queue: { pending_events: 0, oldest_unindexed_age_s: 0 },
  index: { ready: false, model: null },
};

describe('client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('probeHealthz', () => {
    it('identifies a running memhub daemon', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => jsonResponse(healthBody))
      );
      const probe = await probeHealthz(7800);
      expect(probe).toEqual({ kind: 'memhub', info: healthBody });
    });

    it('reports other programs', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => jsonResponse({ hello: 'world' }))
      );
      expect(await probeHealthz(7800)).toEqual({ kind: 'other' });
    });

    it('reports non-200 responses as other', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => jsonResponse({ error: 'nope' }, 404))
      );
      expect(await probeHealthz(7800)).toEqual({ kind: 'other' });
    });

    it('reports unreachable ports', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error('ECONNREFUSED');
        })
      );
      expect(await probeHealthz(7800)).toEqual({ kind: 'unreachable' });
    });

    it('reports non-JSON bodies as other', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('<html>hi</html>', { status: 200 }))
      );
      expect(await probeHealthz(7800)).toEqual({ kind: 'other' });
    });

    it('rejects a memhub-shaped body with a wrong app name', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => jsonResponse({ ...healthBody, app: 'other-app' }))
      );
      expect(await probeHealthz(7800)).toEqual({ kind: 'other' });
    });

    it('probes the expected URL', async () => {
      const fetchMock = vi.fn(async () => jsonResponse(healthBody));
      vi.stubGlobal('fetch', fetchMock);
      await probeHealthz(9999);
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:9999/healthz',
        expect.objectContaining({})
      );
    });
  });

  describe('postShutdown', () => {
    it('sends the token and reports success', async () => {
      const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
      vi.stubGlobal('fetch', fetchMock);
      expect(await postShutdown(7800, 'secret')).toBe(true);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://127.0.0.1:7800/api/shutdown');
      expect(init.method).toBe('POST');
      expect((init.headers as Record<string, string>)['x-memhub-token']).toBe('secret');
    });

    it('returns false for rejected tokens', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => jsonResponse({ error: { code: 'unauthorized' } }, 401))
      );
      expect(await postShutdown(7800, 'bad')).toBe(false);
    });

    it('returns false on network errors', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error('boom');
        })
      );
      expect(await postShutdown(7800, 'secret')).toBe(false);
    });
  });
});

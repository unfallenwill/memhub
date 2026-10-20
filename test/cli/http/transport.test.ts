import { describe, expect, it, vi } from 'vitest';
import { requestJson } from '../../../src/cli/http/transport.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('requestJson', () => {
  it('parses a JSON body', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
    const result = await requestJson({
      method: 'POST',
      url: 'http://127.0.0.1:7800/api/cards',
      body: { title: 'T' },
      fetchImpl,
    });
    expect(result).toEqual({ kind: 'ok', status: 200, body: { ok: true } });
  });

  it('keeps a non-JSON body as text', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>hi</html>', { status: 500 }));
    const result = await requestJson({
      method: 'GET',
      url: 'http://127.0.0.1:7800/healthz',
      fetchImpl,
    });
    expect(result).toEqual({ kind: 'ok', status: 500, body: '<html>hi</html>' });
  });

  it('keeps an empty body as an empty string', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    const result = await requestJson({
      method: 'GET',
      url: 'http://127.0.0.1:7800/healthz',
      fetchImpl,
    });
    expect(result).toEqual({ kind: 'ok', status: 200, body: '' });
  });

  it('reports a network failure as unreachable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const result = await requestJson({
      method: 'GET',
      url: 'http://127.0.0.1:7800/healthz',
      fetchImpl,
    });
    expect(result).toEqual({ kind: 'unreachable' });
  });

  it('aborts a request that takes too long', async () => {
    const fetchImpl = vi.fn(
      async (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })
    );
    const result = await requestJson({
      method: 'GET',
      url: 'http://127.0.0.1:7800/healthz',
      timeoutMs: 20,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual({ kind: 'unreachable' });
  });

  it('uses the injected fetch implementation', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
    await requestJson({
      method: 'GET',
      url: 'http://127.0.0.1:7800/healthz',
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('sends the token and the JSON body', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
    await requestJson({
      method: 'POST',
      url: 'http://127.0.0.1:7800/api/cards',
      token: 'secret',
      body: { title: 'T' },
      fetchImpl,
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:7800/api/cards');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('x-memhub-token')).toBe('secret');
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(String(init.body))).toEqual({ title: 'T' });
  });

  it('sends no content type when the request has no body', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
    await requestJson({
      method: 'POST',
      url: 'http://127.0.0.1:7800/api/shutdown',
      token: 'secret',
      fetchImpl,
    });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).get('content-type')).toBeNull();
    expect(init.body).toBeUndefined();
  });

  it('honours an explicit content type', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
    await requestJson({
      method: 'GET',
      url: 'https://x.example/api/queue',
      token: 'secret',
      contentType: 'application/json',
      fetchImpl,
    });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
  });
});

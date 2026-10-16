import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseSearchArgs, runSearchCommand } from '../../src/cli/search.js';

const homes: string[] = [];

function makeHome(): { home: string; token: string } {
  const home = mkdtempSync(join(tmpdir(), 'memhub-search-test-'));
  homes.push(home);
  const token = 'test-token';
  writeFileSync(join(home, 'token'), token);
  return { home, token };
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  while (homes.length > 0) {
    const home = homes.pop();
    if (home !== undefined) rmSync(home, { recursive: true, force: true });
  }
});

describe('parseSearchArgs', () => {
  it('takes the query positionally and applies defaults', () => {
    expect(parseSearchArgs(['package manager'])).toEqual({
      query: 'package manager',
      mode: 'auto',
      limit: 10,
      port: 7800,
    });
  });

  it('parses all options', () => {
    expect(parseSearchArgs(['q', '--mode', 'keyword', '--limit', '5', '--port', '7900'])).toEqual({
      query: 'q',
      mode: 'keyword',
      limit: 5,
      port: 7900,
    });
  });

  it('rejects a missing query', () => {
    expect(() => parseSearchArgs([])).toThrow('a search query is required');
  });

  it('rejects an unknown option', () => {
    expect(() => parseSearchArgs(['q', '--nope'])).toThrow('unknown option for search');
  });

  it('rejects a second positional argument', () => {
    expect(() => parseSearchArgs(['q', 'extra'])).toThrow('unexpected argument');
  });

  it('parses --url and rejects it together with --port', () => {
    expect(parseSearchArgs(['q', '--url', 'https://x.example'])).toEqual({
      query: 'q',
      mode: 'auto',
      limit: 10,
      port: 7800,
      url: 'https://x.example',
    });
    expect(() => parseSearchArgs(['q', '--url', 'https://x.example', '--port', '7900'])).toThrow(
      'mutually exclusive'
    );
    expect(() => parseSearchArgs(['q', '--url', 'nonsense'])).toThrow('invalid --url');
  });

  it('rejects an invalid mode', () => {
    expect(() => parseSearchArgs(['q', '--mode', 'fuzzy'])).toThrow('invalid --mode');
  });

  it('rejects an out-of-range limit', () => {
    expect(() => parseSearchArgs(['q', '--limit', '0'])).toThrow('invalid --limit');
    expect(() => parseSearchArgs(['q', '--limit', '101'])).toThrow('invalid --limit');
  });
});

describe('runSearchCommand', () => {
  it('posts the query and prints the response JSON on 200', async () => {
    const { home, token } = makeHome();
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        {
          results: [{ id: 1, title: 'Use pnpm', score: 1, matched_by: 'fts' }],
          mode_used: 'auto',
        },
        200
      )
    );
    vi.stubGlobal('fetch', fetchMock);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const code = await runSearchCommand({
      query: 'package manager',
      mode: 'auto',
      limit: 10,
      port: 7800,
      home,
    });

    expect(code).toBe(0);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:7800/api/search');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('x-memhub-token')).toBe(token);
    expect(JSON.parse(String(init.body))).toEqual({
      query: 'package manager',
      mode: 'auto',
      limit: 10,
    });
    expect(log).toHaveBeenCalledWith(
      '{"results":[{"id":1,"title":"Use pnpm","score":1,"matched_by":"fts"}],"mode_used":"auto"}'
    );
  });

  it('exits 1 when no token file exists', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const home = mkdtempSync(join(tmpdir(), 'memhub-search-empty-'));
    homes.push(home);
    const code = await runSearchCommand({ query: 'q', mode: 'auto', limit: 10, port: 7800, home });
    expect(code).toBe(1);
  });

  it('exits 1 with a start hint when the daemon is unreachable', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      })
    );
    const code = await runSearchCommand({
      query: 'q',
      mode: 'auto',
      limit: 10,
      port: 7800,
      home: makeHome().home,
    });
    expect(code).toBe(1);
    expect(error.mock.calls.flat().join('\n')).toContain('memhub server');
  });

  it('prints the error body on a 503 response', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ error: { code: 'index_not_ready', message: 'model loading' } }, 503)
      )
    );
    const code = await runSearchCommand({
      query: 'q',
      mode: 'semantic',
      limit: 10,
      port: 7800,
      home: makeHome().home,
    });
    expect(code).toBe(1);
    expect(error.mock.calls.flat().join('\n')).toContain('index_not_ready');
  });

  it('searches a remote daemon with the stored login token', async () => {
    const home = mkdtempSync(join(tmpdir(), 'memhub-search-test-'));
    homes.push(home);
    writeFileSync(
      join(home, 'credentials.json'),
      JSON.stringify({ version: 1, url: 'https://x.example', token: 'remote-token' })
    );
    const fetchMock = vi.fn(async () => jsonResponse({ results: [], mode_used: 'keyword' }, 200));
    vi.stubGlobal('fetch', fetchMock);

    const code = await runSearchCommand({
      query: 'q',
      mode: 'auto',
      limit: 10,
      port: 7800,
      url: 'https://x.example',
      home,
    });
    expect(code).toBe(0);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://x.example/api/search');
    expect((init.headers as Record<string, string>)['x-memhub-token']).toBe('remote-token');
  });

  it('exits 1 with a login hint when the remote is not logged in', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = await runSearchCommand({
      query: 'q',
      mode: 'auto',
      limit: 10,
      port: 7800,
      url: 'https://x.example',
      home: makeHome().home,
    });
    expect(code).toBe(1);
    expect(error.mock.calls.flat().join('\n')).toContain('memhub login https://x.example');
  });
});

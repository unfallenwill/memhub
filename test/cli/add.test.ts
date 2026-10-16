import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseAddArgs, runAddCommand } from '../../src/cli/add.js';

const homes: string[] = [];

function makeHome(): { home: string; token: string } {
  const home = mkdtempSync(join(tmpdir(), 'memhub-add-test-'));
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

describe('parseAddArgs', () => {
  it('applies defaults when only --title is given', () => {
    expect(parseAddArgs(['--title', 'T'])).toEqual({
      title: 'T',
      body: null,
      type: 'insight',
      cues: [],
      writer: undefined,
      port: 7800,
    });
  });

  it('parses all options', () => {
    expect(
      parseAddArgs([
        '--title',
        'T',
        '--body',
        'B',
        '--type',
        'decision',
        '--cues',
        'a',
        '--cues',
        'b c',
        '--writer',
        'claude',
        '--port',
        '7900',
      ])
    ).toEqual({
      title: 'T',
      body: 'B',
      type: 'decision',
      cues: ['a', 'b c'],
      writer: 'claude',
      port: 7900,
    });
  });

  it('rejects an invalid type', () => {
    expect(() => parseAddArgs(['--title', 'T', '--type', 'nope'])).toThrow(/invalid --type/);
  });

  it('rejects a missing title', () => {
    expect(() => parseAddArgs([])).toThrow('--title is required');
  });

  it('rejects an empty flag value', () => {
    expect(() => parseAddArgs(['--title', 'T', '--body'])).toThrow('--body requires a value');
  });

  it('rejects an unknown option', () => {
    expect(() => parseAddArgs(['--title', 'T', '--nope'])).toThrow('unknown option for add');
  });

  it('rejects an invalid port', () => {
    expect(() => parseAddArgs(['--title', 'T', '--port', '0'])).toThrow('invalid --port');
  });
});

describe('runAddCommand', () => {
  it('posts the card and prints the response JSON on 202', async () => {
    const { home, token } = makeHome();
    const fetchMock = vi.fn(async () =>
      jsonResponse({ id: 7, indexed: false, deduplicated: false }, 202)
    );
    vi.stubGlobal('fetch', fetchMock);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const code = await runAddCommand({
      title: 'Use pnpm',
      body: 'Never npm.',
      type: 'preference',
      cues: ['pnpm'],
      writer: 'claude',
      port: 7800,
      home,
    });

    expect(code).toBe(0);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:7800/api/cards');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('x-memhub-token')).toBe(token);
    expect(JSON.parse(String(init.body))).toEqual({
      title: 'Use pnpm',
      body: 'Never npm.',
      type: 'preference',
      cues: ['pnpm'],
      writer: 'claude',
    });
    expect(log).toHaveBeenCalledWith('{"id":7,"indexed":false,"deduplicated":false}');
  });

  it('omits the writer field when not given', async () => {
    const { home } = makeHome();
    const fetchMock = vi.fn(async () =>
      jsonResponse({ id: 8, indexed: false, deduplicated: false }, 202)
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await runAddCommand({
      title: 'T',
      body: 'B',
      type: 'insight',
      cues: [],
      writer: undefined,
      port: 7800,
      home,
    });

    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).not.toHaveProperty('writer');
  });

  it('reads the body from the injected stdin reader', async () => {
    const { home } = makeHome();
    const fetchMock = vi.fn(async () =>
      jsonResponse({ id: 9, indexed: false, deduplicated: false }, 202)
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const code = await runAddCommand({
      title: 'T',
      body: null,
      type: 'insight',
      cues: [],
      writer: undefined,
      port: 7800,
      home,
      readStdin: async () => 'piped body',
    });

    expect(code).toBe(0);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body)).body).toBe('piped body');
  });

  it('fails fast when stdin is a terminal and --body is missing', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    try {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const code = await runAddCommand({
        title: 'T',
        body: null,
        type: 'insight',
        cues: [],
        writer: undefined,
        port: 7800,
        home: makeHome().home,
      });
      expect(code).toBe(1);
      expect(error.mock.calls.flat().join('\n')).toContain('--body');
    } finally {
      delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
  });

  it('rejects an empty body', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = await runAddCommand({
      title: 'T',
      body: '   ',
      type: 'insight',
      cues: [],
      writer: undefined,
      port: 7800,
      home: makeHome().home,
    });
    expect(code).toBe(1);
    expect(error.mock.calls.flat().join('\n')).toContain('empty');
  });

  it('exits 1 when no token file exists', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const home = mkdtempSync(join(tmpdir(), 'memhub-add-empty-'));
    homes.push(home);
    const code = await runAddCommand({
      title: 'T',
      body: 'B',
      type: 'insight',
      cues: [],
      writer: undefined,
      port: 7800,
      home,
    });
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
    const code = await runAddCommand({
      title: 'T',
      body: 'B',
      type: 'insight',
      cues: [],
      writer: undefined,
      port: 7800,
      home: makeHome().home,
    });
    expect(code).toBe(1);
    expect(error.mock.calls.flat().join('\n')).toContain('memhub server');
  });

  it('prints the error body and a token hint on 401', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ error: { code: 'unauthorized', message: 'bad token' } }, 401)
      )
    );
    const code = await runAddCommand({
      title: 'T',
      body: 'B',
      type: 'insight',
      cues: [],
      writer: undefined,
      port: 7800,
      home: makeHome().home,
    });
    expect(code).toBe(1);
    const output = error.mock.calls.flat().join('\n');
    expect(output).toContain('unauthorized');
    expect(output).toContain('Hint');
  });

  it('prints the error body on a non-202 response', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ error: { code: 'validation_failed', message: 'title too long' } }, 400)
      )
    );
    const code = await runAddCommand({
      title: 'T',
      body: 'B',
      type: 'insight',
      cues: [],
      writer: undefined,
      port: 7800,
      home: makeHome().home,
    });
    expect(code).toBe(1);
    expect(error.mock.calls.flat().join('\n')).toContain('validation_failed');
  });
});

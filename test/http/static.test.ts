import type { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/http/app.js';
import {
  defaultWebDist,
  resolveWebDist,
  StaticSite,
  staticResponse,
  TOKEN_PLACEHOLDER,
  WEB_DIST_ENV,
} from '../../src/http/static.js';
import { createTestDb, type TestDb } from '../test-utils.js';

const TOKEN = 'static-test-token';

/** Build a minimal fake web dist in a temp directory. */
function buildFakeDist(): string {
  const root = mkdtempSync(join(tmpdir(), 'memhub-webdist-'));
  mkdirSync(join(root, 'assets'));
  writeFileSync(
    join(root, 'index.html'),
    `<!doctype html><html><script>window.__MEMHUB_TOKEN__ = "${TOKEN_PLACEHOLDER}";</script>` +
      `<script src="/assets/app.js"></script></html>`
  );
  writeFileSync(join(root, 'assets', 'app.js'), 'console.log("app");');
  writeFileSync(join(root, 'assets', 'style.css'), 'body { color: red; }');
  return root;
}

describe('StaticSite', () => {
  let dist: string;

  beforeEach(() => {
    dist = buildFakeDist();
  });

  afterEach(() => {
    rmSync(dist, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  describe('index', () => {
    it('injects the token into the built index.html', () => {
      const site = new StaticSite(dist);
      const file = site.index(TOKEN);
      expect(file).not.toBeNull();
      const html = file!.body as string;
      expect(html).toContain(`window.__MEMHUB_TOKEN__ = "${TOKEN}"`);
      expect(html).not.toContain(`"${TOKEN_PLACEHOLDER}"`);
    });

    it('escapes quotes and backslashes in the token', () => {
      const site = new StaticSite(dist);
      const file = site.index('we"ird\\token');
      const html = file!.body as string;
      expect(html).toContain('"we\\"ird\\\\token"');
    });

    it('is served with no-store because it embeds the token', () => {
      const site = new StaticSite(dist);
      const file = site.index(TOKEN);
      expect(file!.cacheControl).toBe('no-store');
      expect(file!.contentType).toBe('text/html; charset=utf-8');
    });

    it('returns null when index.html is missing', () => {
      const empty = mkdtempSync(join(tmpdir(), 'memhub-webdist-'));
      try {
        expect(new StaticSite(empty).index(TOKEN)).toBeNull();
      } finally {
        rmSync(empty, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    });

    it('replaces every quoted placeholder occurrence, keeping the variable name', () => {
      const root = mkdtempSync(join(tmpdir(), 'memhub-webdist-'));
      try {
        writeFileSync(
          join(root, 'index.html'),
          `window.__MEMHUB_TOKEN__ = "${TOKEN_PLACEHOLDER}"; data = ${`"${TOKEN_PLACEHOLDER}"`};`
        );
        const html = new StaticSite(root).index(TOKEN)!.body as string;
        expect(html).toBe(`window.__MEMHUB_TOKEN__ = "${TOKEN}"; data = "${TOKEN}";`);
      } finally {
        rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    });
  });

  describe('file', () => {
    it('serves assets with the right content type', () => {
      const site = new StaticSite(dist);
      expect(site.file('/assets/app.js')?.contentType).toBe('text/javascript; charset=utf-8');
      expect(site.file('/assets/style.css')?.contentType).toBe('text/css; charset=utf-8');
      expect(site.file('/index.html')?.contentType).toBe('text/html; charset=utf-8');
    });

    it('returns the file contents as bytes', () => {
      const site = new StaticSite(dist);
      const file = site.file('/assets/app.js')!;
      const body = Buffer.from(file.body as Uint8Array).toString('utf-8');
      expect(body).toBe('console.log("app");');
    });

    it('rejects path traversal', () => {
      const site = new StaticSite(dist);
      expect(site.file('/../package.json')).toBeNull();
      expect(site.file('/%2e%2e/package.json')).toBeNull();
      expect(site.file('/assets/../../package.json')).toBeNull();
    });

    it('rejects malformed paths', () => {
      const site = new StaticSite(dist);
      expect(site.file('')).toBeNull();
      expect(site.file('/')).toBeNull();
      expect(site.file('/%00')).toBeNull();
      expect(site.file('/missing.js')).toBeNull();
    });

    it('decodes URI-encoded asset names', () => {
      const site = new StaticSite(dist);
      writeFileSync(join(dist, 'assets', 'a b.js'), 'x');
      expect(site.file('/assets/a%20b.js')).not.toBeNull();
    });
  });
});

describe('staticResponse', () => {
  it('sets content-type and cache-control headers', () => {
    const response = staticResponse({
      body: 'hello',
      contentType: 'text/plain',
      cacheControl: 'no-store',
    });
    expect(response.headers.get('content-type')).toBe('text/plain');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('defaultWebDist', () => {
  it('can be overridden with MEMHUB_WEB_DIST', () => {
    const previous = process.env[WEB_DIST_ENV];
    try {
      const override = resolve('custom-web-dist');
      process.env[WEB_DIST_ENV] = override;
      expect(defaultWebDist()).toBe(resolve(override));
    } finally {
      if (previous === undefined) {
        delete process.env[WEB_DIST_ENV];
      } else {
        process.env[WEB_DIST_ENV] = previous;
      }
    }
  });

  it('points at web/dist relative to the package root by default', () => {
    const previous = process.env[WEB_DIST_ENV];
    try {
      delete process.env[WEB_DIST_ENV];
      const result = defaultWebDist().replace(/\\/g, '/');
      // Either layout is valid depending on whether the web UI was built:
      // source (src/http -> repo/web/dist) or compiled fallback (dist/src/http).
      expect(result.endsWith('/memhub/web/dist') || result.endsWith('/web/dist')).toBe(true);
      expect(result).toMatch(/web\/dist\/?$/);
    } finally {
      if (previous !== undefined) {
        process.env[WEB_DIST_ENV] = previous;
      }
    }
  });

  it('ignores a blank override', () => {
    const previous = process.env[WEB_DIST_ENV];
    try {
      process.env[WEB_DIST_ENV] = '   ';
      expect(defaultWebDist().replace(/\\/g, '/')).toMatch(/web\/dist\/?$/);
    } finally {
      if (previous === undefined) {
        delete process.env[WEB_DIST_ENV];
      } else {
        process.env[WEB_DIST_ENV] = previous;
      }
    }
  });
});

describe('resolveWebDist', () => {
  it('prefers the first candidate that has a built index.html', () => {
    // Compiled layout: dist/src/http -> three levels up -> repo/web/dist
    const moduleDir = join('x', 'dist', 'src', 'http');
    const compiledLayout = join(moduleDir, '..', '..', '..', 'web', 'dist');
    const found = resolveWebDist(moduleDir, path => path === join(compiledLayout, 'index.html'));
    expect(found).toBe(compiledLayout);
  });

  it('falls back to the compiled layout when nothing is built', () => {
    const moduleDir = join('x', 'src', 'http');
    const compiledLayout = join(moduleDir, '..', '..', '..', 'web', 'dist');
    expect(resolveWebDist(moduleDir, () => false)).toBe(compiledLayout);
  });
});

describe('static hosting routes', () => {
  let t: TestDb;
  let db: DatabaseSync;
  let dist: string;

  function request(path: string, init: RequestInit = {}): Promise<Response> {
    const app = createApp({
      db,
      token: TOKEN,
      version: '1.2.3-test',
      pid: 4242,
      startedAt: Date.now(),
      requestShutdown: () => {},
      webDist: dist,
    });
    const headers = {
      host: '127.0.0.1:7800',
      ...((init.headers as Record<string, string>) ?? {}),
    };
    return app.request(path, { ...init, headers });
  }

  beforeEach(() => {
    t = createTestDb();
    db = t.db;
    dist = buildFakeDist();
  });

  afterEach(() => {
    t.close();
    rmSync(dist, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('serves index.html at GET / without a token', async () => {
    const response = await request('/');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const html = await response.text();
    expect(html).toContain(`window.__MEMHUB_TOKEN__ = "${TOKEN}"`);
    expect(html).not.toContain(`"${TOKEN_PLACEHOLDER}"`);
  });

  it('serves hashed assets from the dist directory', async () => {
    const response = await request('/assets/app.js');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(await response.text()).toBe('console.log("app");');
  });

  it('keeps the Host header check in front of static files', async () => {
    const response = await request('/', { headers: { host: 'evil.example' } });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_host');
  });

  it('answers 404 web_ui_not_built when the dist has no index.html', async () => {
    rmSync(dist, { recursive: true, force: true });
    mkdirSync(dist, { recursive: true });
    const response = await request('/');
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('web_ui_not_built');
  });

  it('answers 404 JSON for unknown files', async () => {
    const response = await request('/nope.js');
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
  });

  it('still requires the token for API routes next to static files', async () => {
    const response = await request('/api/cards');
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('unauthorized');
  });

  it('does not register static routes when webDist is unset', async () => {
    const app = createApp({
      db,
      token: TOKEN,
      version: '1.2.3-test',
      pid: 4242,
      startedAt: Date.now(),
      requestShutdown: () => {},
    });
    const response = await app.request('/', { headers: { host: '127.0.0.1:7800' } });
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
  });
});

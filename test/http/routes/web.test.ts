import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { registerWebRoutes } from '../../../src/http/routes/web.js';
import { bareApp } from './helpers.js';

const TOKEN = 'daemon-token';

describe('registerWebRoutes', () => {
  const dirs: string[] = [];

  function webDist(): string {
    const dir = mkdtempSync(join(tmpdir(), 'memhub-webdist-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'index.html'), '<html>token:"__MEMHUB_TOKEN__"</html>');
    writeFileSync(join(dir, 'app.js'), 'console.log(1);');
    return dir;
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it('serves the token-injected page at / without a token', async () => {
    const instance = bareApp();
    registerWebRoutes(instance, { webDist: webDist(), token: TOKEN });
    const response = await instance.request('/');
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(`token:"${TOKEN}"`);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
  });

  it('serves the same page at /index.html', async () => {
    const instance = bareApp();
    registerWebRoutes(instance, { webDist: webDist(), token: TOKEN });
    const response = await instance.request('/index.html');
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(`token:"${TOKEN}"`);
  });

  it('omits the token when the daemon must not embed it', async () => {
    const instance = bareApp();
    registerWebRoutes(instance, { webDist: webDist(), token: TOKEN, injectWebToken: false });
    const response = await instance.request('/');
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('token:""');
  });

  it('serves the static assets of the built UI', async () => {
    const instance = bareApp();
    registerWebRoutes(instance, { webDist: webDist(), token: TOKEN });
    const response = await instance.request('/app.js');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
  });

  it('answers 404 for a missing file', async () => {
    const instance = bareApp();
    registerWebRoutes(instance, { webDist: webDist(), token: TOKEN });
    const response = await instance.request('/missing.js');
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
  });

  it('registers no route at all when the web UI is not built', async () => {
    const instance = bareApp();
    registerWebRoutes(instance, { webDist: undefined, token: TOKEN });
    const response = await instance.request('/');
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
  });
});

import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hono } from 'hono';
import { AdminPasswordStore, hashPassword } from '../../src/daemon/admin-password.js';
import { createApp } from '../../src/http/app.js';
import { DeviceTokenStore, tokenHash } from '../../src/db/device-tokens.js';
import { createTestDb, type TestDb } from '../test-utils.js';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const TOKEN = 'test-token';

/**
 * Loopback env for in-process requests: the Host check only accepts
 * local Host values from connections that actually originate locally
 * (fail-closed without socket info), so tests must provide it.
 */
const LOCAL_ENV = { incoming: { socket: { remoteAddress: '127.0.0.1' } } };

describe('device auth flow', () => {
  let t: TestDb;
  let db: DatabaseSync;
  let requestShutdown: ReturnType<typeof vi.fn>;
  let webDist: string | undefined;
  let currentApp: Hono | undefined;
  /** Mutable clock so poll-interval logic can be tested without sleeps. */
  let clock: number;
  /** First-run setup code injected into the app (null = none configured). */
  let setupCode: string | null;
  let setupCodePath: string | undefined;
  let onSetupComplete: ReturnType<typeof vi.fn>;
  const dirs: string[] = [];

  const TEST_SETUP_CODE = 'ABC234-DEF567';

  /**
   * The device flow keeps grants and rate limits in memory inside the
   * app instance, so one app is reused across the requests of a test
   * (exactly like the daemon, which builds its app once). Rebuild it
   * explicitly whenever webDist changes.
   */
  function app(): Hono {
    if (currentApp === undefined) {
      currentApp = createApp({
        db,
        token: TOKEN,
        version: '1.2.3-test',
        pid: 4242,
        startedAt: Date.now(),
        requestShutdown,
        webDist,
        authNow: () => clock,
        getSetupCode: () => setupCode,
        setupCodePath,
        onSetupComplete,
      });
    }
    return currentApp;
  }

  function rebuildApp(): Hono {
    currentApp = undefined;
    return app();
  }

  /** POST with a local Host header (required by the middleware). */
  async function post(path: string, body: unknown, init: RequestInit = {}): Promise<Response> {
    return app().request(
      path,
      {
        ...init,
        method: 'POST',
        headers: {
          host: '127.0.0.1:7800',
          'content-type': 'application/json',
          ...((init.headers as Record<string, string>) ?? {}),
        },
        body: JSON.stringify(body),
      },
      LOCAL_ENV
    );
  }

  async function postForm(path: string, form: Record<string, string>): Promise<Response> {
    return app().request(
      path,
      {
        method: 'POST',
        headers: { host: '127.0.0.1:7800', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form).toString(),
      },
      LOCAL_ENV
    );
  }

  async function get(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = {
      host: '127.0.0.1:7800',
      ...((init.headers as Record<string, string>) ?? {}),
    };
    return app().request(path, { ...init, headers }, LOCAL_ENV);
  }

  /** Start a device flow; returns the grant payload. */
  async function startFlow(): Promise<Record<string, unknown>> {
    const response = await post('/oauth/device/code', { client_id: 'memhub-cli' });
    expect(response.status).toBe(200);
    return (await response.json()) as Record<string, unknown>;
  }

  function makeWebDist(): string {
    const dir = mkdtempSync(join(tmpdir(), 'memhub-webdist-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'index.html'), '<html>token:"__MEMHUB_TOKEN__"</html>');
    return dir;
  }

  beforeEach(() => {
    t = createTestDb();
    db = t.db;
    requestShutdown = vi.fn();
    webDist = undefined;
    currentApp = undefined;
    clock = Date.now();
    setupCode = null;
    setupCodePath = undefined;
    onSetupComplete = vi.fn();
  });

  afterEach(() => {
    t.close();
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  describe('POST /oauth/device/code', () => {
    it('issues a grant with setup flag when uninitialized', async () => {
      const grant = await startFlow();
      expect(grant.requires_setup).toBe(true);
      expect(String(grant.user_code)).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
      expect(String(grant.device_code)).toMatch(/^[0-9a-f]{64}$/);
      expect(grant.interval).toBe(5);
      expect(grant.expires_in).toBe(300);
      expect(String(grant.verification_uri_complete)).toContain('/login?code=');
    });

    it('reflects the initialized state once a password exists', async () => {
      new AdminPasswordStore(db).set(hashPassword('password-1'));
      const grant = await startFlow();
      expect(grant.requires_setup).toBe(false);
    });

    it('uses the client-provided base_url for verification links', async () => {
      const response = await post('/oauth/device/code', {
        client_id: 'memhub-cli',
        base_url: 'https://memhub.example.com',
      });
      const grant = (await response.json()) as Record<string, string>;
      expect(grant.verification_uri).toBe('https://memhub.example.com/login');
      expect(
        grant.verification_uri_complete.startsWith('https://memhub.example.com/login?code=')
      ).toBe(true);
    });

    it('rejects wrong client ids and malformed bodies', async () => {
      for (const body of [{}, { client_id: 'other-app' }, null]) {
        const response = await post('/oauth/device/code', body);
        expect(response.status).toBe(400);
        const error = (await response.json()) as { error: string };
        expect(error.error).toBe('invalid_request');
      }
    });

    it('rejects a non-http base_url', async () => {
      const response = await post('/oauth/device/code', {
        client_id: 'memhub-cli',
        base_url: 'ftp://example.com',
      });
      expect(response.status).toBe(400);
    });

    it('caps pending grants per address (429 after the cap)', async () => {
      // Tests call app.request without socket info, so every request
      // shares the 'unknown' address — exactly the single-attacker shape.
      let last: Response | null = null;
      for (let i = 0; i <= 10; i++) {
        last = await post('/oauth/device/code', { client_id: 'memhub-cli' });
      }
      expect(last).not.toBeNull();
      expect(last!.status).toBe(429);
      const error = (await last!.json()) as { error: string };
      expect(error.error).toBe('slow_down');
    });
  });

  describe('GET /login', () => {
    it('shows the setup hint without a matching grant when uninitialized', async () => {
      const response = await get('/login');
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('not set up yet');
      expect(html).not.toContain('<form');
      expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
      expect(response.headers.get('cache-control')).toBe('no-store');
    });

    it('shows the setup form for a grant-initiated first login', async () => {
      setupCodePath = '/data/setup-code';
      const grant = await startFlow();
      const response = await get(`/login?code=${String(grant.user_code)}`);
      const html = await response.text();
      expect(html).toContain('Set the admin password');
      expect(html).toContain('password_confirm');
      expect(html).toContain('setup_code');
      expect(html).toContain('cat /data/setup-code');
    });

    it('shows the login form when initialized', async () => {
      new AdminPasswordStore(db).set(hashPassword('password-1'));
      const response = await get('/login');
      expect(await response.text()).toContain('Authorize this device');
    });

    it('escapes a script-injected code parameter', async () => {
      new AdminPasswordStore(db).set(hashPassword('password-1'));
      const response = await get('/login?code=<script>alert(1)</script>');
      const html = await response.text();
      expect(html).not.toContain('<script>');
    });

    it('renders error and done states', async () => {
      expect(await (await get('/login?error=invalid')).text()).toContain('Wrong device code');
      expect(await (await get('/login?done=1')).text()).toContain('Authorized');
    });
  });

  describe('POST /oauth/device/authorize + /oauth/device/token', () => {
    it('runs the full first-login setup flow and issues a working token', async () => {
      setupCode = TEST_SETUP_CODE;
      const grant = await startFlow();
      // Poll once before approval: pending.
      const pending = await post('/oauth/device/token', {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: grant.device_code,
        client_id: 'memhub-cli',
      });
      expect(pending.status).toBe(400);
      expect(((await pending.json()) as { error: string }).error).toBe('authorization_pending');

      // Approve via the setup form (device code + setup code + password).
      const approved = await postForm('/oauth/device/authorize', {
        user_code: String(grant.user_code),
        setup_code: TEST_SETUP_CODE,
        password: 'initial-password',
        password_confirm: 'initial-password',
      });
      expect(approved.status).toBe(302);
      expect(approved.headers.get('location')).toBe('/login?done=1');
      expect(new AdminPasswordStore(db).get()).not.toBeNull();
      expect(onSetupComplete).toHaveBeenCalledTimes(1);

      // Advance past the poll interval, then claim the token.
      clock += 6000;
      const claimed = await post('/oauth/device/token', {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: grant.device_code,
        client_id: 'memhub-cli',
      });
      expect(claimed.status).toBe(200);
      const tokenBody = (await claimed.json()) as { access_token: string; token_type: string };
      expect(tokenBody.token_type).toBe('Bearer');
      expect(tokenBody.access_token).toMatch(/^[0-9a-f]{64}$/);

      // The token authorizes /api.
      const cards = await get('/api/cards', {
        headers: { 'x-memhub-token': tokenBody.access_token },
      });
      expect(cards.status).toBe(200);

      // The grant is single-use.
      clock += 6000;
      const replay = await post('/oauth/device/token', {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: grant.device_code,
        client_id: 'memhub-cli',
      });
      expect(((await replay.json()) as { error: string }).error).toBe('expired_token');
    });

    it('redirects into the SPA with the token when the web UI is built', async () => {
      webDist = makeWebDist();
      rebuildApp();
      new AdminPasswordStore(db).set(hashPassword('password-1'));
      const grant = await startFlow();
      const approved = await postForm('/oauth/device/authorize', {
        user_code: String(grant.user_code),
        password: 'password-1',
      });
      expect(approved.status).toBe(302);
      const location = approved.headers.get('location') ?? '';
      expect(location.startsWith('/#token=')).toBe(true);
    });

    it('runs the normal login flow after setup', async () => {
      new AdminPasswordStore(db).set(hashPassword('password-1'));
      const grant = await startFlow();
      const approved = await postForm('/oauth/device/authorize', {
        user_code: String(grant.user_code),
        password: 'password-1',
      });
      expect(approved.status).toBe(302);
      clock += 6000;
      const claimed = await post('/oauth/device/token', {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: grant.device_code,
        client_id: 'memhub-cli',
      });
      expect(claimed.status).toBe(200);
    });

    it('denies after three wrong passwords', async () => {
      new AdminPasswordStore(db).set(hashPassword('password-1'));
      const grant = await startFlow();
      for (let i = 0; i < 2; i++) {
        const response = await postForm('/oauth/device/authorize', {
          user_code: String(grant.user_code),
          password: 'wrong-password',
        });
        expect(response.status).toBe(302);
        expect(response.headers.get('location')).toContain('error=invalid');
      }
      const denied = await postForm('/oauth/device/authorize', {
        user_code: String(grant.user_code),
        password: 'wrong-password',
      });
      expect(denied.headers.get('location')).toContain('error=denied');
      clock += 6000;
      const token = await post('/oauth/device/token', {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: grant.device_code,
        client_id: 'memhub-cli',
      });
      expect(((await token.json()) as { error: string }).error).toBe('access_denied');
    });

    it('refuses the first-login setup without the correct setup code', async () => {
      setupCode = TEST_SETUP_CODE;
      const grant = await startFlow();
      for (const bad of ['WRONG0-CODE00', 'short']) {
        const response = await postForm('/oauth/device/authorize', {
          user_code: String(grant.user_code),
          setup_code: bad,
          password: 'initial-password',
          password_confirm: 'initial-password',
        });
        expect(response.headers.get('location')).toContain('error=invalid');
      }
      // The admin password was never set and no token was minted.
      expect(new AdminPasswordStore(db).get()).toBeNull();
      clock += 6000;
      const poll = await post('/oauth/device/token', {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: grant.device_code,
        client_id: 'memhub-cli',
      });
      expect(((await poll.json()) as { error: string }).error).toBe('authorization_pending');
    });

    it('refuses the first-login setup entirely when no setup code is configured', async () => {
      const grant = await startFlow();
      const response = await postForm('/oauth/device/authorize', {
        user_code: String(grant.user_code),
        setup_code: TEST_SETUP_CODE,
        password: 'initial-password',
        password_confirm: 'initial-password',
      });
      expect(response.headers.get('location')).toContain('error=invalid');
      expect(new AdminPasswordStore(db).get()).toBeNull();
    });

    it('asks for the setup code lazily (never after initialization)', async () => {
      let calls = 0;
      const countingApp = createApp({
        db,
        token: TOKEN,
        version: '1.2.3-test',
        pid: 4242,
        startedAt: Date.now(),
        requestShutdown,
        authNow: () => clock,
        getSetupCode: () => {
          calls++;
          return TEST_SETUP_CODE;
        },
      });
      new AdminPasswordStore(db).set(hashPassword('password-1'));
      // The grant must come from the same app instance (grants are in-memory).
      const grantResponse = await countingApp.request(
        '/oauth/device/code',
        {
          method: 'POST',
          headers: { host: '127.0.0.1:7800', 'content-type': 'application/json' },
          body: JSON.stringify({ client_id: 'memhub-cli' }),
        },
        LOCAL_ENV
      );
      const grant = (await grantResponse.json()) as { user_code: string };
      const response = await countingApp.request(
        '/oauth/device/authorize',
        {
          method: 'POST',
          headers: { host: '127.0.0.1:7800', 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            user_code: grant.user_code,
            password: 'password-1',
          }).toString(),
        },
        LOCAL_ENV
      );
      expect(response.status).toBe(302);
      // The password branch must never consult the setup-code provider.
      expect(calls).toBe(0);
    });

    it('accepts the setup code case-insensitively and without the hyphen', async () => {
      setupCode = TEST_SETUP_CODE;
      const grant = await startFlow();
      const approved = await postForm('/oauth/device/authorize', {
        user_code: String(grant.user_code),
        setup_code: TEST_SETUP_CODE.toLowerCase().replace('-', ''),
        password: 'initial-password',
        password_confirm: 'initial-password',
      });
      expect(approved.status).toBe(302);
      expect(new AdminPasswordStore(db).get()).not.toBeNull();
    });

    it('rejects short or mismatched setup passwords without initializing', async () => {
      setupCode = TEST_SETUP_CODE;
      const grant = await startFlow();
      const short = await postForm('/oauth/device/authorize', {
        user_code: String(grant.user_code),
        setup_code: TEST_SETUP_CODE,
        password: 'short',
        password_confirm: 'short',
      });
      expect(short.headers.get('location')).toContain('error=invalid');
      const mismatch = await postForm('/oauth/device/authorize', {
        user_code: String(grant.user_code),
        setup_code: TEST_SETUP_CODE,
        password: 'long-enough-1',
        password_confirm: 'different-1',
      });
      expect(mismatch.headers.get('location')).toContain('error=invalid');
      expect(new AdminPasswordStore(db).get()).toBeNull();
    });

    it('redirects to missing for an unknown user code', async () => {
      new AdminPasswordStore(db).set(hashPassword('password-1'));
      const response = await postForm('/oauth/device/authorize', {
        user_code: 'ZZZZ-ZZZZ',
        password: 'password-1',
      });
      expect(response.headers.get('location')).toContain('error=missing');
    });

    it('keeps the code prefilled on retry redirects', async () => {
      new AdminPasswordStore(db).set(hashPassword('password-1'));
      const grant = await startFlow();
      const response = await postForm('/oauth/device/authorize', {
        user_code: String(grant.user_code),
        password: 'wrong-password',
      });
      const location = response.headers.get('location') ?? '';
      expect(location).toContain('error=invalid');
      expect(location).toContain(`code=${String(grant.user_code)}`);
    });

    it('rejects unsupported grant types', async () => {
      const response = await post('/oauth/device/token', {
        grant_type: 'password',
        device_code: 'x',
        client_id: 'memhub-cli',
      });
      expect(((await response.json()) as { error: string }).error).toBe('unsupported_grant_type');
    });

    it('returns expired_token for unknown device codes', async () => {
      const response = await post('/oauth/device/token', {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: '0'.repeat(64),
        client_id: 'memhub-cli',
      });
      expect(((await response.json()) as { error: string }).error).toBe('expired_token');
    });

    it('enforces the poll interval', async () => {
      new AdminPasswordStore(db).set(hashPassword('password-1'));
      const grant = await startFlow();
      const first = await post('/oauth/device/token', {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: grant.device_code,
        client_id: 'memhub-cli',
      });
      expect(first.status).toBe(400);
      const immediate = await post('/oauth/device/token', {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: grant.device_code,
        client_id: 'memhub-cli',
      });
      expect(((await immediate.json()) as { error: string }).error).toBe('slow_down');
    });
  });

  describe('host check coverage', () => {
    it('applies to all new routes', async () => {
      for (const [method, path] of [
        ['POST', '/oauth/device/code'],
        ['GET', '/login'],
        ['POST', '/oauth/device/token'],
        ['DELETE', '/api/auth/token'],
        ['GET', '/api/auth/devices'],
      ] as const) {
        const response = await app().request(
          path,
          {
            method,
            headers: { host: 'evil.example' },
            body: method === 'POST' ? '{}' : undefined,
          },
          LOCAL_ENV
        );
        expect(response.status, `${method} ${path}`).toBe(403);
      }
    });
  });

  describe('device management endpoints', () => {
    let deviceToken: string;

    beforeEach(async () => {
      new AdminPasswordStore(db).set(hashPassword('password-1'));
      const grant = await startFlow();
      await postForm('/oauth/device/authorize', {
        user_code: String(grant.user_code),
        password: 'password-1',
      });
      const claimed = await post('/oauth/device/token', {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: grant.device_code,
        client_id: 'memhub-cli',
      });
      deviceToken = ((await claimed.json()) as { access_token: string }).access_token;
    });

    it('lists devices with the current one flagged', async () => {
      const response = await get('/api/auth/devices', {
        headers: { 'x-memhub-token': deviceToken },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { devices: { current: boolean; label: string }[] };
      expect(body.devices).toHaveLength(1);
      expect(body.devices[0].current).toBe(true);
      expect(body.devices[0].label).toBe('cli');
    });

    it('requires a token', async () => {
      expect((await get('/api/auth/devices')).status).toBe(401);
    });

    it('revokes a device by id, cutting its access', async () => {
      const list = await get('/api/auth/devices', {
        headers: { 'x-memhub-token': deviceToken },
      });
      const id = ((await list.json()) as { devices: { id: number }[] }).devices[0].id;
      const revoked = await app().request(
        `/api/auth/devices/${id}`,
        {
          method: 'DELETE',
          headers: { host: '127.0.0.1:7800', 'x-memhub-token': deviceToken },
        },
        LOCAL_ENV
      );
      expect(revoked.status).toBe(200);
      const after = await get('/api/cards', { headers: { 'x-memhub-token': deviceToken } });
      expect(after.status).toBe(401);
      expect(
        (
          await app().request(
            '/api/auth/devices/9999',
            {
              method: 'DELETE',
              headers: { host: '127.0.0.1:7800', 'x-memhub-token': TOKEN },
            },
            LOCAL_ENV
          )
        ).status
      ).toBe(404);
    });

    it('DELETE /api/auth/token revokes the calling device', async () => {
      const response = await app().request(
        '/api/auth/token',
        {
          method: 'DELETE',
          headers: { host: '127.0.0.1:7800', 'x-memhub-token': deviceToken },
        },
        LOCAL_ENV
      );
      expect(response.status).toBe(200);
      const after = await get('/api/cards', { headers: { 'x-memhub-token': deviceToken } });
      expect(after.status).toBe(401);
    });

    it('refuses to revoke the daemon token via the device endpoint', async () => {
      const response = await app().request(
        '/api/auth/token',
        {
          method: 'DELETE',
          headers: { host: '127.0.0.1:7800', 'x-memhub-token': TOKEN },
        },
        LOCAL_ENV
      );
      expect(response.status).toBe(400);
    });

    it('records last_used_at via the throttled touch', async () => {
      await get('/api/queue', { headers: { 'x-memhub-token': deviceToken } });
      const hash = tokenHash(deviceToken);
      const record = new DeviceTokenStore(db).findActiveByHash(hash);
      expect(record?.lastUsedAt).not.toBeNull();
    });
  });

  describe('web token injection gating', () => {
    it('does not inject the daemon token when injectWebToken is false', async () => {
      webDist = makeWebDist();
      const response = await createApp({
        db,
        token: TOKEN,
        version: '1.2.3-test',
        pid: 4242,
        startedAt: Date.now(),
        requestShutdown,
        webDist,
        injectWebToken: false,
      }).request('/', { headers: { host: 'localhost:7800' } }, LOCAL_ENV);
      const html = await response.text();
      expect(html).not.toContain(TOKEN);
    });

    it('injects the daemon token by default (local daemons)', async () => {
      webDist = makeWebDist();
      const response = await app().request('/', { headers: { host: 'localhost:7800' } }, LOCAL_ENV);
      expect(await response.text()).toContain(TOKEN);
    });
  });
});

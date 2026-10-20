/**
 * Characterization test: the HTTP authentication matrix.
 *
 * Every route is exercised with four credentials (no token / wrong token /
 * daemon token / device token) and the resulting status code is pinned.
 * This is the guard rail for the modular refactor: the security posture of
 * the API must not change while the code is moved around.
 *
 * NOTE on the expectations: the matrix below records the *measured*
 * behaviour of the current implementation. One deviation from the plan in
 * the task description is intentional and documented in the test:
 * `POST /api/shutdown` answers 401 (not 403) for a missing or wrong
 * token, because the generic /api/* token middleware rejects the request
 * before the route handler can apply its "daemon token only" rule. Only a
 * *valid* device token reaches that rule and gets 403.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { createApp } from '../../src/http/app.js';
import { DeviceTokenStore, tokenHash } from '../../src/db/device-tokens.js';
import { createRuntimeContext, type RuntimeContext } from '../../src/runtime/context.js';
import { cardInput, createTestDb, type TestDb } from '../test-utils.js';

const DAEMON_TOKEN = 'daemon-token-matrix';
const DEVICE_TOKEN = 'd'.repeat(64);
const WRONG_TOKEN = 'not-the-daemon-token';

/** Loopback env: the Host check fails closed without socket info. */
const LOCAL_ENV = { incoming: { socket: { remoteAddress: '127.0.0.1' } } };

/** The four credential kinds the matrix is built from. */
type CredentialName = 'none' | 'wrong' | 'daemon' | 'device';

interface Credential {
  readonly name: CredentialName;
  /** Value sent as X-Memhub-Token; undefined = header omitted. */
  readonly token: string | undefined;
}

const CREDENTIALS: readonly Credential[] = [
  { name: 'none', token: undefined },
  { name: 'wrong', token: WRONG_TOKEN },
  { name: 'daemon', token: DAEMON_TOKEN },
  { name: 'device', token: DEVICE_TOKEN },
];

/** One row of the matrix: a route plus the expected status per credential. */
interface RouteCase {
  readonly label: string;
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly path: string;
  /** JSON body sent with the request (undefined = no body). */
  readonly body?: string | undefined;
  /** Whether a card with id 1 has to exist for the route to answer 200. */
  readonly seedCard?: boolean | undefined;
  readonly status: Readonly<Record<CredentialName, number>>;
}

const ROUTES: readonly RouteCase[] = [
  {
    label: 'GET /healthz',
    method: 'GET',
    path: '/healthz',
    status: { none: 200, wrong: 200, daemon: 200, device: 200 },
  },
  {
    label: 'GET /api/cards',
    method: 'GET',
    path: '/api/cards',
    status: { none: 401, wrong: 401, daemon: 200, device: 200 },
  },
  {
    label: 'POST /api/cards',
    method: 'POST',
    path: '/api/cards',
    body: JSON.stringify({ title: 'matrix card', body: 'matrix body', type: 'fact' }),
    status: { none: 401, wrong: 401, daemon: 202, device: 202 },
  },
  {
    label: 'GET /api/cards/1',
    method: 'GET',
    path: '/api/cards/1',
    seedCard: true,
    status: { none: 401, wrong: 401, daemon: 200, device: 200 },
  },
  {
    label: 'PATCH /api/cards/1',
    method: 'PATCH',
    path: '/api/cards/1',
    body: JSON.stringify({ title: 'matrix card renamed' }),
    seedCard: true,
    status: { none: 401, wrong: 401, daemon: 200, device: 200 },
  },
  {
    label: 'DELETE /api/cards/1',
    method: 'DELETE',
    path: '/api/cards/1',
    seedCard: true,
    status: { none: 401, wrong: 401, daemon: 200, device: 200 },
  },
  {
    label: 'POST /api/cards/1/invalidate',
    method: 'POST',
    path: '/api/cards/1/invalidate',
    body: JSON.stringify({}),
    seedCard: true,
    status: { none: 401, wrong: 401, daemon: 200, device: 200 },
  },
  {
    label: 'POST /api/search',
    method: 'POST',
    path: '/api/search',
    body: JSON.stringify({ query: 'matrix' }),
    status: { none: 401, wrong: 401, daemon: 200, device: 200 },
  },
  {
    label: 'GET /api/activity',
    method: 'GET',
    path: '/api/activity',
    status: { none: 401, wrong: 401, daemon: 200, device: 200 },
  },
  {
    label: 'GET /api/queue',
    method: 'GET',
    path: '/api/queue',
    status: { none: 401, wrong: 401, daemon: 200, device: 200 },
  },
  {
    // The generic /api/* middleware answers 401 for missing/unknown
    // tokens; the route's own "daemon token only" rule (403
    // shutdown_forbidden) only applies to a valid *device* token.
    label: 'POST /api/shutdown',
    method: 'POST',
    path: '/api/shutdown',
    body: JSON.stringify({}),
    status: { none: 401, wrong: 401, daemon: 200, device: 403 },
  },
  {
    label: 'POST /oauth/device/code',
    method: 'POST',
    path: '/oauth/device/code',
    body: JSON.stringify({ client_id: 'memhub-cli' }),
    status: { none: 200, wrong: 200, daemon: 200, device: 200 },
  },
  {
    label: 'GET /login',
    method: 'GET',
    path: '/login',
    status: { none: 200, wrong: 200, daemon: 200, device: 200 },
  },
  {
    label: 'GET /',
    method: 'GET',
    path: '/',
    status: { none: 200, wrong: 200, daemon: 200, device: 200 },
  },
];

/** Look up a matrix row by its label. */
function routeByLabel(label: string): RouteCase {
  const found = ROUTES.find(route => route.label === label);
  if (found === undefined) throw new Error(`no matrix route labelled ${label}`);
  return found;
}

describe('HTTP auth matrix', () => {
  let t: TestDb;
  let db: DatabaseSync;
  let context: RuntimeContext;
  let requestShutdown: ReturnType<typeof vi.fn>;
  let webDist: string;
  const dirs: string[] = [];

  function app() {
    return createApp({
      context,
      token: DAEMON_TOKEN,
      version: '1.2.3-test',
      pid: 4242,
      startedAt: Date.now() - 1000,
      requestShutdown,
      webDist,
    });
  }

  /** Perform one request with the given credential. */
  async function call(route: RouteCase, credential: Credential): Promise<Response> {
    const headers: Record<string, string> = { host: '127.0.0.1:7800' };
    if (credential.token !== undefined) headers['x-memhub-token'] = credential.token;
    if (route.body !== undefined) headers['content-type'] = 'application/json';
    return app().request(
      route.path,
      {
        method: route.method,
        headers,
        ...(route.body === undefined ? {} : { body: route.body }),
      },
      LOCAL_ENV
    );
  }

  beforeEach(() => {
    t = createTestDb();
    db = t.db;
    context = createRuntimeContext({ db });
    requestShutdown = vi.fn();
    // A minimal built web UI so GET / can serve the SPA shell.
    webDist = mkdtempSync(join(tmpdir(), 'memhub-authmatrix-web-'));
    dirs.push(webDist);
    writeFileSync(join(webDist, 'index.html'), '<html>token:"__MEMHUB_TOKEN__"</html>');
    // The device token is only known to the database, never to the app.
    new DeviceTokenStore(db).create(tokenHash(DEVICE_TOKEN), 'matrix-device');
  });

  afterEach(() => {
    t.close();
    while (dirs.length > 0) {
      const dir = dirs.pop();
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const route of ROUTES) {
    describe(route.label, () => {
      for (const credential of CREDENTIALS) {
        it(`answers ${route.status[credential.name]} with the ${credential.name} credential`, async () => {
          if (route.seedCard === true) {
            t.cards.createCard(cardInput({ title: 'seed card', body: 'seed body' }));
          }
          const response = await call(route, credential);
          expect(response.status, `${route.label} / ${credential.name}`).toBe(
            route.status[credential.name]
          );
        });
      }
    });
  }

  describe('error body shapes', () => {
    it('uses {error:{code,message}} for /api/* authentication failures', async () => {
      for (const credential of [
        { name: 'none', token: undefined },
        { name: 'wrong', token: WRONG_TOKEN },
      ] as const) {
        const response = await call(routeByLabel('GET /api/cards'), credential);
        expect(response.status, credential.name).toBe(401);
        const body = (await response.json()) as { error?: { code?: unknown; message?: unknown } };
        expect(body.error).toBeDefined();
        expect(typeof body.error?.code).toBe('string');
        expect(typeof body.error?.message).toBe('string');
        expect(body.error?.code).toBe('unauthorized');
      }
    });

    it('uses {error:{code,message}} for /api/* validation failures', async () => {
      const response = await app().request(
        '/api/cards',
        {
          method: 'POST',
          headers: {
            host: '127.0.0.1:7800',
            'content-type': 'application/json',
            'x-memhub-token': DAEMON_TOKEN,
          },
          body: JSON.stringify({ body: 'no title', type: 'fact' }),
        },
        LOCAL_ENV
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error?: { code?: unknown; message?: unknown } };
      expect(typeof body.error?.code).toBe('string');
      expect(typeof body.error?.message).toBe('string');
      expect(body.error?.code).toBe('invalid_request');
    });

    it('uses the flat {error,error_description} shape for /oauth/* failures', async () => {
      const response = await app().request(
        '/oauth/device/code',
        {
          method: 'POST',
          headers: { host: '127.0.0.1:7800', 'content-type': 'application/json' },
          body: JSON.stringify({ client_id: 'not-memhub' }),
        },
        LOCAL_ENV
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error?: unknown; error_description?: unknown };
      expect(typeof body.error).toBe('string');
      expect(typeof body.error_description).toBe('string');
      expect(body.error).toBe('invalid_request');
    });

    it('rejects a non-JSON /oauth/* body with the flat shape', async () => {
      const response = await app().request(
        '/oauth/device/code',
        {
          method: 'POST',
          headers: { host: '127.0.0.1:7800', 'content-type': 'application/json' },
          body: 'not json',
        },
        LOCAL_ENV
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error?: unknown; error_description?: unknown };
      expect(body.error).toBe('invalid_request');
      expect(body.error_description).toBe('request body must be valid JSON');
    });
  });

  describe('POST /api/shutdown', () => {
    it('reports shutdown_forbidden for a device token', async () => {
      const response = await call(routeByLabel('POST /api/shutdown'), {
        name: 'device',
        token: DEVICE_TOKEN,
      });
      expect(response.status).toBe(403);
      const body = (await response.json()) as { error?: { code?: unknown; message?: unknown } };
      expect(body.error?.code).toBe('shutdown_forbidden');
      expect(typeof body.error?.message).toBe('string');
      expect(requestShutdown).not.toHaveBeenCalled();
    });

    it('shuts the daemon down for the daemon token only', async () => {
      const response = await call(routeByLabel('POST /api/shutdown'), {
        name: 'daemon',
        token: DAEMON_TOKEN,
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { ok?: boolean };
      expect(body.ok).toBe(true);
      expect(requestShutdown).toHaveBeenCalledTimes(1);
    });
  });

  describe('GET / without a built web UI', () => {
    it('answers 404 with the not_found code', async () => {
      // The SPA is only served when a web/dist directory exists; without
      // it the root path falls through to the JSON 404 handler.
      const response = await createApp({
        context,
        token: DAEMON_TOKEN,
        version: '1.2.3-test',
        pid: 4242,
        startedAt: Date.now() - 1000,
        requestShutdown,
      }).request('/', { headers: { host: '127.0.0.1:7800' } }, LOCAL_ENV);
      expect(response.status).toBe(404);
      const body = (await response.json()) as { error?: { code?: unknown; message?: unknown } };
      expect(body.error?.code).toBe('not_found');
      expect(typeof body.error?.message).toBe('string');
    });
  });
});

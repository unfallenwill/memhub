/**
 * The rejection paths of the device-flow routes
 * (src/http/routes/device-auth.ts).
 *
 * The happy path (issue a code, approve it, poll for the token) is
 * covered by test/http/routes/device-auth.test.ts. This file covers the
 * branches that refuse a request: the throttling, the malformed bodies,
 * the missing form fields, the storage failure while the admin password
 * is set, and the device management endpoints.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tokenHash } from '../../../src/db/device-tokens.js';
import type { AdminPasswordRepository } from '../../../src/core/ports/repositories.js';
import {
  registerDeviceAuthRoutes,
  type DeviceAuthDeps,
  type DeviceAuthLimits,
} from '../../../src/http/routes/device-auth.js';
import { bareApp, createRouteFixture, jsonRequest, type RouteFixture } from './helpers.js';

const TOKEN = 'daemon-token';
const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';
/** A setup code in its canonical form (12 Crockford characters). */
const SETUP_CODE = 'ABCDEF-GHJKMN';

describe('registerDeviceAuthRoutes rejection paths', () => {
  let fixture: RouteFixture;

  /** Mount the routes with an explicit dependency set. */
  function appWith(deps: Partial<DeviceAuthDeps> = {}): ReturnType<typeof bareApp> {
    const instance = bareApp();
    registerDeviceAuthRoutes(instance, {
      deviceTokens: fixture.context.deviceTokens,
      adminPassword: fixture.context.adminPassword,
      legacyToken: TOKEN,
      ...deps,
    });
    return instance;
  }

  /** Request a device code and return the parsed grant. */
  async function requestGrant(
    app: ReturnType<typeof bareApp>,
    body: Record<string, unknown> = { client_id: 'memhub-cli' }
  ): Promise<{ device_code: string; user_code: string }> {
    const response = await jsonRequest(app, '/oauth/device/code', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return (await response.json()) as { device_code: string; user_code: string };
  }

  beforeEach(() => {
    fixture = createRouteFixture();
  });

  afterEach(() => {
    fixture.close();
  });

  it('refuses a base_url that is not a URL at all', async () => {
    const response = await jsonRequest(appWith(), '/oauth/device/code', {
      method: 'POST',
      body: JSON.stringify({ client_id: 'memhub-cli', base_url: 'not a url' }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('invalid_request');
  });

  it('refuses a base_url with a non-http scheme', async () => {
    const response = await jsonRequest(appWith(), '/oauth/device/code', {
      method: 'POST',
      body: JSON.stringify({ client_id: 'memhub-cli', base_url: 'ftp://x.example' }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('invalid_request');
  });

  it('throttles the device code requests of one address', async () => {
    const limits: Partial<DeviceAuthLimits> = { codeRequestsPerMin: 1 };
    const app = appWith({ limits });

    const first = await requestGrant(app);
    expect(first.device_code).toHaveLength(64);

    const second = await jsonRequest(app, '/oauth/device/code', {
      method: 'POST',
      body: JSON.stringify({ client_id: 'memhub-cli' }),
    });
    expect(second.status).toBe(429);
    const body = (await second.json()) as { error: string; error_description: string };
    expect(body.error).toBe('slow_down');
    expect(body.error_description).toContain('try again in');
  });

  it('renders the login page without a prefilled code for an empty one', async () => {
    const response = await appWith().request('/login?code=');

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).not.toContain('value="');
  });

  it('throttles the authorize attempts of one address', async () => {
    const limits: Partial<DeviceAuthLimits> = { authorizeFailuresPerMin: 1 };
    const app = appWith({ limits });

    const first = await app.request('/oauth/device/authorize', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'user_code=AAAA-AAAA&password=wrong',
    });
    expect(first.status).toBe(302);

    const second = await app.request('/oauth/device/authorize', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'user_code=AAAA-AAAA&password=wrong',
    });
    expect(second.status).toBe(429);
    expect(await second.text()).toContain('too many attempts');
  });

  it('redirects to the login page when the form has no user code', async () => {
    const app = appWith();

    const response = await app.request('/oauth/device/authorize', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'password=whatever',
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('error=missing');
  });

  it('redirects to the login page when the form has no password', async () => {
    const app = appWith();
    const grant = await requestGrant(app);

    const response = await app.request('/oauth/device/authorize', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `user_code=${grant.user_code}`,
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('error=invalid');
  });

  it('refuses the first login without a setup code', async () => {
    const app = appWith({ getSetupCode: () => null });

    const grant = await requestGrant(app);
    const response = await app.request('/oauth/device/authorize', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `user_code=${grant.user_code}&password=longenough&password_confirm=longenough`,
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('error=invalid');
  });

  it('reports a failure while the admin password is stored', async () => {
    const failing: AdminPasswordRepository = {
      get: () => null,
      set: () => {
        throw new Error('disk is full');
      },
      clear: () => undefined,
    };
    const app = appWith({ adminPassword: failing, getSetupCode: () => SETUP_CODE });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    const grant = await requestGrant(app);
    const response = await app.request('/oauth/device/authorize', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body:
        `user_code=${grant.user_code}&password=longenough&password_confirm=longenough` +
        `&setup_code=${SETUP_CODE}`,
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('error=invalid');
    expect(logged.mock.calls.flat().join('\n')).toContain('failed to store admin password');
  });

  it('refuses a token request with a malformed body', async () => {
    const response = await jsonRequest(appWith(), '/oauth/device/token', {
      method: 'POST',
      body: '{ not json',
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; error_description: string };
    expect(body.error).toBe('invalid_request');
    expect(body.error_description).toContain('valid JSON');
  });

  it('refuses a token request with the wrong grant type', async () => {
    const response = await jsonRequest(appWith(), '/oauth/device/token', {
      method: 'POST',
      body: JSON.stringify({
        grant_type: 'authorization_code',
        device_code: 'd'.repeat(64),
        client_id: 'memhub-cli',
      }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('unsupported_grant_type');
  });

  it('refuses a token request without a grant type', async () => {
    const response = await jsonRequest(appWith(), '/oauth/device/token', {
      method: 'POST',
      body: JSON.stringify({ device_code: 'd'.repeat(64), client_id: 'memhub-cli' }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; error_description: string };
    expect(body.error).toBe('invalid_request');
    expect(body.error_description).toBe('invalid token request');
  });

  it('refuses to revoke a token that does not exist', async () => {
    const response = await jsonRequest(appWith(), '/api/auth/token', {
      method: 'DELETE',
      headers: { 'x-memhub-token': 'unknown-token' },
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('invalid_request');
    expect(body.error.message).toContain('no device token matched');
  });

  it('refuses to revoke a token when no token was sent at all', async () => {
    const response = await jsonRequest(appWith(), '/api/auth/token', { method: 'DELETE' });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain('no device token matched');
  });

  it('lists the devices without a current one when no token was sent', async () => {
    fixture.context.deviceTokens.create(tokenHash('d'.repeat(64)), 'laptop');

    const response = await jsonRequest(appWith(), '/api/auth/devices');

    expect(response.status).toBe(200);
    const body = (await response.json()) as { devices: { current: boolean }[] };
    expect(body.devices).toHaveLength(1);
    expect(body.devices[0].current).toBe(false);
  });

  it('lists the devices without a current one for the daemon token', async () => {
    fixture.context.deviceTokens.create(tokenHash('d'.repeat(64)), 'laptop');

    const response = await jsonRequest(appWith(), '/api/auth/devices', {
      headers: { 'x-memhub-token': TOKEN },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { devices: { current: boolean }[] };
    expect(body.devices[0].current).toBe(false);
  });

  it('refuses to revoke a device by a non-numeric id', async () => {
    const response = await jsonRequest(appWith(), '/api/auth/devices/not-a-number', {
      method: 'DELETE',
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain('positive integer');
  });

  it('reports an unknown device id', async () => {
    const response = await jsonRequest(appWith(), '/api/auth/devices/4242', { method: 'DELETE' });

    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
  });
});

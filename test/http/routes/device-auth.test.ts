import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tokenHash } from '../../../src/db/device-tokens.js';
import { deviceAuthDeps, registerDeviceAuthRoutes } from '../../../src/http/routes/device-auth.js';
// The old import path must keep working: it is a re-export shim.
import { registerDeviceAuthRoutes as registerFromShim } from '../../../src/http/device-auth.js';
import { bareApp, createRouteFixture, jsonRequest, type RouteFixture } from './helpers.js';

const TOKEN = 'daemon-token';

describe('registerDeviceAuthRoutes', () => {
  let fixture: RouteFixture;

  function app(): ReturnType<typeof bareApp> {
    const instance = bareApp();
    registerDeviceAuthRoutes(
      instance,
      deviceAuthDeps({
        context: fixture.context,
        token: TOKEN,
        version: '1.2.3-test',
        pid: 1,
        startedAt: Date.now(),
        requestShutdown: () => undefined,
      })
    );
    return instance;
  }

  beforeEach(() => {
    fixture = createRouteFixture();
  });

  afterEach(() => {
    fixture.close();
  });

  it('is still exported from the old module path', () => {
    expect(registerFromShim).toBe(registerDeviceAuthRoutes);
  });

  it('issues a device code without a token', async () => {
    const response = await jsonRequest(app(), '/oauth/device/code', {
      method: 'POST',
      body: JSON.stringify({ client_id: 'memhub-cli' }),
    });
    expect(response.status).toBe(200);
    const grant = (await response.json()) as {
      device_code: string;
      user_code: string;
      verification_uri: string;
      requires_setup: boolean;
    };
    expect(grant.user_code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(grant.verification_uri).toContain('/login');
    expect(grant.requires_setup).toBe(true);
  });

  it('rejects a wrong client id with the flat OAuth error shape', async () => {
    const response = await jsonRequest(app(), '/oauth/device/code', {
      method: 'POST',
      body: JSON.stringify({ client_id: 'other-app' }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; error_description: string };
    expect(body.error).toBe('invalid_request');
    expect(typeof body.error_description).toBe('string');
  });

  it('serves the login page', async () => {
    const response = await app().request('/login');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
  });

  it('answers expired_token for an unknown device code', async () => {
    const response = await jsonRequest(app(), '/oauth/device/token', {
      method: 'POST',
      body: JSON.stringify({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: 'f'.repeat(64),
        client_id: 'memhub-cli',
      }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('expired_token');
  });

  it('lists the device tokens', async () => {
    fixture.context.deviceTokens.create(tokenHash('d'.repeat(64)), 'laptop');
    const response = await jsonRequest(app(), '/api/auth/devices', {
      headers: { 'x-memhub-token': 'd'.repeat(64) },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { devices: { label: string; current: boolean }[] };
    expect(body.devices).toHaveLength(1);
    expect(body.devices[0].label).toBe('laptop');
    expect(body.devices[0].current).toBe(true);
  });

  it('refuses to revoke the daemon token itself', async () => {
    const response = await jsonRequest(app(), '/api/auth/token', {
      method: 'DELETE',
      headers: { 'x-memhub-token': TOKEN },
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_request');
  });

  it('revokes a device token', async () => {
    const deviceToken = 'd'.repeat(64);
    fixture.context.deviceTokens.create(tokenHash(deviceToken), 'laptop');
    const response = await jsonRequest(app(), '/api/auth/token', {
      method: 'DELETE',
      headers: { 'x-memhub-token': deviceToken },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    const [device] = fixture.context.deviceTokens.list();
    expect(device?.revokedAt).not.toBeNull();
  });
});

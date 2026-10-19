/**
 * The authorize route of the device flow (src/http/routes/device-auth.ts).
 *
 * A form that cannot be read at all - the connection broke while the
 * body was on its way - is answered with the login page instead of an
 * unhandled error.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  registerDeviceAuthRoutes,
  type DeviceAuthDeps,
} from '../../../src/http/routes/device-auth.js';
import { bareApp, createRouteFixture, type RouteFixture } from './helpers.js';

describe('an authorize form that cannot be read', () => {
  let fixture: RouteFixture;

  function appWith(deps: Partial<DeviceAuthDeps> = {}): ReturnType<typeof bareApp> {
    const instance = bareApp();
    registerDeviceAuthRoutes(instance, {
      deviceTokens: fixture.context.deviceTokens,
      adminPassword: fixture.context.adminPassword,
      legacyToken: 'daemon-token',
      ...deps,
    });
    return instance;
  }

  beforeEach(() => {
    fixture = createRouteFixture();
  });

  afterEach(() => {
    fixture.close();
  });

  it('redirects to the login page', async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.error(new Error('the connection broke'));
      },
    });
    const init = {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      duplex: 'half',
    } as unknown as RequestInit;

    const response = await appWith().request('/oauth/device/authorize', init);

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('error=invalid');
  });
});

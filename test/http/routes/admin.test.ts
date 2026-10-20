import { describe, expect, it, vi } from 'vitest';
import { registerAdminRoutes } from '../../../src/http/routes/admin.js';
import { bareApp, jsonRequest } from './helpers.js';

const TOKEN = 'daemon-token';

describe('registerAdminRoutes', () => {
  function app(requestShutdown: () => void): ReturnType<typeof bareApp> {
    const instance = bareApp();
    registerAdminRoutes(instance, { token: TOKEN, requestShutdown });
    return instance;
  }

  it('shuts the daemon down with the daemon token', async () => {
    const requestShutdown = vi.fn();
    const response = await jsonRequest(app(requestShutdown), '/api/shutdown', {
      method: 'POST',
      headers: { 'x-memhub-token': TOKEN },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(requestShutdown).toHaveBeenCalledTimes(1);
  });

  it('refuses a device token with 403 shutdown_forbidden', async () => {
    const requestShutdown = vi.fn();
    const response = await jsonRequest(app(requestShutdown), '/api/shutdown', {
      method: 'POST',
      headers: { 'x-memhub-token': 'd'.repeat(64) },
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('shutdown_forbidden');
    expect(requestShutdown).not.toHaveBeenCalled();
  });

  it('refuses a request without a token', async () => {
    const requestShutdown = vi.fn();
    const response = await jsonRequest(app(requestShutdown), '/api/shutdown', { method: 'POST' });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('shutdown_forbidden');
    expect(requestShutdown).not.toHaveBeenCalled();
  });
});

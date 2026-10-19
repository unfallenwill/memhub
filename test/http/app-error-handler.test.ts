import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/http/app.js';
import { createRuntimeContext, type RuntimeContext } from '../../src/runtime/context.js';
import { createTestDb, type TestDb } from '../test-utils.js';

const TOKEN = 'test-token';

/** Loopback env: the Host check fails closed without socket info. */
const LOCAL_ENV = { incoming: { socket: { remoteAddress: '127.0.0.1' } } };

describe('app error handler', () => {
  let t: TestDb;
  let context: RuntimeContext;

  beforeEach(() => {
    t = createTestDb();
    context = createRuntimeContext({ db: t.db });
  });

  afterEach(() => {
    t.close();
  });

  it('answers 500 with the house shape for an unexpected error', async () => {
    const app = createApp({
      context,
      token: TOKEN,
      version: '1.2.3-test',
      pid: 4242,
      startedAt: Date.now(),
      requestShutdown: () => undefined,
    });
    app.get('/boom', () => {
      throw new Error('boom');
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const response = await app.request(
        '/boom',
        { headers: { host: '127.0.0.1:7800' } },
        LOCAL_ENV
      );
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: { code: 'internal_error', message: 'Internal server error' },
      });
      expect(logged).toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });
});

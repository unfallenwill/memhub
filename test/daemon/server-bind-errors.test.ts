/**
 * The HTTP server bootstrap (src/daemon/server.ts).
 *
 * The daemon must turn the "address already in use" failure into a
 * typed error and must release the socket when the bind fails for any
 * other reason (an unresolvable host, for example). Neither failure may
 * leave a listening socket behind.
 */

import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { PortInUseError, startHttpServer } from '../../src/daemon/server.js';

describe('startHttpServer', () => {
  it('binds a port and reports the port it got', async () => {
    const app = new Hono();
    app.get('/healthz', c => c.json({ app: 'memhub' }));

    const handle = await startHttpServer(app, { host: '127.0.0.1', port: 0 });
    try {
      expect(handle.port).toBeGreaterThan(0);
      const response = await fetch(`http://127.0.0.1:${handle.port}/healthz`);
      expect(await response.json()).toEqual({ app: 'memhub' });
    } finally {
      await handle.close();
    }
  });

  it('reports a taken port as a PortInUseError', async () => {
    const app = new Hono();
    const first = await startHttpServer(app, { host: '127.0.0.1', port: 0 });
    try {
      await expect(
        startHttpServer(app, { host: '127.0.0.1', port: first.port })
      ).rejects.toBeInstanceOf(PortInUseError);
    } finally {
      await first.close();
    }
  });

  it('rejects with the original error when the host cannot be resolved', async () => {
    const app = new Hono();

    await expect(
      startHttpServer(app, { host: 'memhub.invalid', port: 0 })
    ).rejects.not.toBeInstanceOf(PortInUseError);
  });
});

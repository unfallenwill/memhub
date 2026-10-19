/**
 * The body size limit (src/http/middleware/body-limit.ts).
 *
 * The middleware rejects a request whose Content-Length exceeds the cap
 * BEFORE the handler runs, and buffers a streamed (chunked) body up to
 * the cap. Both paths are exercised here; the rejection must never reach
 * the route handler.
 */

import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { bodySizeLimit } from '../../../src/http/middleware/body-limit.js';

describe('bodySizeLimit', () => {
  it('rejects a request whose Content-Length exceeds the cap', async () => {
    const app = new Hono();
    const reached = { value: false };
    app.use(
      '*',
      bodySizeLimit(10, () => new Response('too big', { status: 413 }))
    );
    app.post('/', c => {
      reached.value = true;
      return c.text('ok');
    });

    const response = await app.request('/', {
      method: 'POST',
      headers: { 'content-length': '100' },
      body: 'x',
    });

    expect(response.status).toBe(413);
    expect(await response.text()).toBe('too big');
    expect(reached.value).toBe(false);
  });

  it('lets a request within the cap through', async () => {
    const app = new Hono();
    app.use(
      '*',
      bodySizeLimit(1024, () => new Response('too big', { status: 413 }))
    );
    app.post('/', async c => c.text(await c.req.text()));

    const response = await app.request('/', { method: 'POST', body: 'hello' });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('hello');
  });

  it('rejects a streamed body that grows past the cap', async () => {
    const app = new Hono();
    const reached = { value: false };
    app.use(
      '*',
      bodySizeLimit(4, () => new Response('too big', { status: 413 }))
    );
    app.post('/', c => {
      reached.value = true;
      return c.text('ok');
    });

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('1234567890'));
        controller.close();
      },
    });

    const response = await app.request('/', { method: 'POST', body: stream, duplex: 'half' });

    expect(response.status).toBe(413);
    expect(reached.value).toBe(false);
  });

  it('re-attaches a streamed body that fits', async () => {
    const app = new Hono();
    app.use(
      '*',
      bodySizeLimit(1024, () => new Response('too big', { status: 413 }))
    );
    app.post('/', async c => c.text(await c.req.text()));

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('piped body'));
        controller.close();
      },
    });

    const response = await app.request('/', { method: 'POST', body: stream, duplex: 'half' });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('piped body');
  });

  it('lets a request without a body through', async () => {
    const app = new Hono();
    app.use(
      '*',
      bodySizeLimit(1, () => new Response('too big', { status: 413 }))
    );
    app.get('/', c => c.text('ok'));

    const response = await app.request('/');

    expect(response.status).toBe(200);
  });
});

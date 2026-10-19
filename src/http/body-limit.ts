/**
 * Request body size limits.
 *
 * Hono's own bodyLimit middleware lets the handler run while the body
 * streams and relies on the read error propagating afterwards — but this
 * app's route handlers catch body-read failures (JSON parse errors) and
 * answer 400, which would swallow the limit violation. This variant is
 * deterministic: streamed bodies without a Content-Length are consumed
 * up front (bounded by the cap), oversized requests are rejected before
 * any handler runs, and in-range bodies are re-wrapped unchanged.
 */

import type { MiddlewareHandler } from 'hono';

/**
 * Middleware that rejects request bodies above `maxSize` by calling
 * `reject()` (which returns the error response for the route's error
 * shape). Bodies with a Content-Length are checked by header; streamed
 * (chunked) bodies are buffered up to the cap and re-attached.
 */
export function bodySizeLimit(maxSize: number, reject: () => Response): MiddlewareHandler {
  return async (c, next) => {
    const req = c.req.raw;
    if (req.body === null) {
      await next();
      return;
    }
    const declared = req.headers.get('content-length');
    if (declared !== null) {
      const length = Number(declared);
      if (Number.isFinite(length) && length > maxSize) {
        return reject();
      }
      await next();
      return;
    }
    const reader = req.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    let exceeded = false;
    for (;;) {
      const result = (await reader.read()) as { done: boolean; value?: Uint8Array };
      if (result.done || result.value === undefined) break;
      size += result.value.byteLength;
      if (size > maxSize) {
        exceeded = true;
        break;
      }
      chunks.push(result.value as Uint8Array<ArrayBuffer>);
    }
    if (exceeded) {
      await reader.cancel().catch(() => {});
      return reject();
    }
    // Rebuild from primitives: `new Request(req, ...)` reads private
    // undici state of the original request instance and throws in the
    // real @hono/node-server runtime ("Cannot read private member
    // #state"), even though it works under Hono's in-process test
    // request path.
    c.req.raw = new Request(req.url, {
      method: req.method,
      headers: req.headers,
      body: new Blob(chunks),
      redirect: 'manual',
    });
    await next();
    return;
  };
}

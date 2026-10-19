/**
 * Hono application with all MemHub HTTP routes.
 *
 * The composition root of the HTTP adapter: it wires the middleware, the
 * error handlers and the route modules (./routes/), which are registered
 * in the order the API contract requires - the SPA wildcard goes last.
 */

import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ApiError } from './errors.js';
import { bodySizeLimit } from './middleware/body-limit.js';
import { createHostGuard } from './middleware/host-guard.js';
import { createTokenAuth } from './middleware/token-auth.js';
import { registerActivityRoutes } from './routes/activity.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerCardRoutes } from './routes/cards.js';
import { deviceAuthDeps, registerDeviceAuthRoutes } from './routes/device-auth.js';
import type { AppDeps } from './routes/deps.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerQueueRoutes } from './routes/queue.js';
import { registerSearchRoutes } from './routes/search.js';
import { registerWebRoutes } from './routes/web.js';

// The card serialization and the dependency contracts are part of the
// public API of the package; they live in their own modules and are
// re-exported here.
export { serializeCard } from './mappers.js';
export type { AppContext, AppDeps } from './routes/deps.js';

/** Body cap for the device-flow endpoints (form/JSON, a few hundred bytes). */
export const OAUTH_BODY_LIMIT_BYTES = 4096;

/** Body cap for /api/* (a 200k-char card body can reach ~1.2MB JSON-escaped). */
export const API_BODY_LIMIT_BYTES = 2 * 1024 * 1024;

/** The 413 answer of the /oauth/* body cap (the flat OAuth error shape). */
function oauthBodyTooLarge(): Response {
  return Response.json(
    { error: 'invalid_request', error_description: 'request body too large' },
    { status: 413 }
  );
}

/** The 413 answer of the /api/* body cap (the house error shape). */
function apiBodyTooLarge(): Response {
  return Response.json(
    { error: { code: 'payload_too_large', message: 'Request body exceeds the size limit' } },
    { status: 413 }
  );
}

/** Build the MemHub HTTP application. */
export function createApp(deps: AppDeps): Hono {
  // The stores are never built here: the app uses the instances of the
  // composition root, so there is exactly one store graph per process.
  const { context } = deps;

  const app = new Hono();

  // DNS rebinding defense / remote perimeter: local Host headers
  // (localhost, 127.0.0.1, [::1]) are only accepted when the request
  // actually originates from this machine; anything else must match an
  // explicitly allowed host (MEMHUB_ALLOWED_HOSTS).
  app.use('*', createHostGuard(deps.allowedHosts ?? []));

  // Request body caps (apply to streamed/chunked bodies too, unlike a
  // Content-Length check). The device-flow endpoints only ever receive a
  // few hundred bytes; API bodies are bounded by the card schema (a
  // 200k-char body can grow to ~1.2MB as JSON unicode escapes).
  app.use('/oauth/*', bodySizeLimit(OAUTH_BODY_LIMIT_BYTES, oauthBodyTooLarge));
  app.use('/api/*', bodySizeLimit(API_BODY_LIMIT_BYTES, apiBodyTooLarge));

  // Token auth for everything under /api/*: the daemon's own token
  // (file/env) or any active device-flow token.
  app.use('/api/*', createTokenAuth({ token: deps.token, deviceTokens: context.deviceTokens }));

  app.onError((error, c) => {
    if (error instanceof ApiError) {
      return c.json(
        { error: { code: error.code, message: error.message } },
        error.status as ContentfulStatusCode
      );
    }
    console.error('unhandled error:', error);
    return c.json({ error: { code: 'internal_error', message: 'Internal server error' } }, 500);
  });

  app.notFound(c => c.json({ error: { code: 'not_found', message: 'Not found' } }, 404));

  // The route registration order is part of the contract: /api/shutdown
  // first, then the card routes, the search, the activity log and the
  // queue; the device-flow routes follow, and the SPA wildcard is last.
  // Every route module declares the slice of the app dependencies it
  // needs, so the app hands over its dependencies and TypeScript checks
  // that the slice is covered.
  registerHealthRoutes(app, deps);
  registerAdminRoutes(app, deps);
  registerCardRoutes(app, deps);
  registerSearchRoutes(app, deps);
  registerActivityRoutes(app, deps);
  registerQueueRoutes(app, deps);

  // Device-flow login (registered before the SPA wildcard so /login and
  // /oauth/* keep priority). These routes are token-exempt by design:
  // /oauth/device/code is the public entry point of RFC 8628, and /login
  // authenticates with the admin password, not a token.
  registerDeviceAuthRoutes(app, deviceAuthDeps(deps));

  // Web UI static hosting (registered last so /api routes keep priority).
  registerWebRoutes(app, deps);

  return app;
}

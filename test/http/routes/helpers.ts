/**
 * Helpers for the route module tests.
 *
 * The route modules are independent of the composition root: the Host
 * guard, the body caps and the token auth are wired by src/http/app.ts.
 * A test can therefore mount a single route module on a bare Hono app
 * and drive it without the rest of the stack.
 */

import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ApiError } from '../../../src/http/errors.js';
import { createRuntimeContext, type RuntimeContext } from '../../../src/runtime/context.js';
import { createTestDb, type TestDb } from '../../test-utils.js';

/**
 * A bare app with the house error handler installed.
 *
 * The handler mirrors the one of the composition root (src/http/app.ts),
 * so a route module answers with the unified {error:{code,message}}
 * shape even when it is mounted on its own.
 */
export function bareApp(): Hono {
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof ApiError) {
      return c.json(
        { error: { code: error.code, message: error.message } },
        error.status as ContentfulStatusCode
      );
    }
    return c.json({ error: { code: 'internal_error', message: 'Internal server error' } }, 500);
  });
  app.notFound(c => c.json({ error: { code: 'not_found', message: 'Not found' } }, 404));
  return app;
}

/** A throwaway database plus the runtime context built on top of it. */
export interface RouteFixture {
  readonly db: TestDb['db'];
  readonly context: RuntimeContext;
  close(): void;
}

/** Create an isolated runtime context (never the real ~/.memhub). */
export function createRouteFixture(): RouteFixture {
  const t = createTestDb();
  const context = createRuntimeContext({ db: t.db });
  return {
    db: t.db,
    context,
    close: () => {
      t.close();
    },
  };
}

/** A JSON request against a bare app. */
export function jsonRequest(app: Hono, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = {
    'content-type': 'application/json',
    ...((init.headers as Record<string, string>) ?? {}),
  };
  return app.request(path, { ...init, headers });
}

/** The error body of a failed request. */
export interface ErrorBody {
  readonly error: { readonly code: string; readonly message: string };
}

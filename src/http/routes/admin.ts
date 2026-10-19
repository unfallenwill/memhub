/**
 * POST /api/shutdown - the daemon administration endpoint.
 *
 * Server administration, not a web/CLI session action: only the
 * daemon's own token may stop the daemon, never a device-flow token.
 */

import type { Hono } from 'hono';
import { forbidden } from '../errors.js';
import { tokensEqual } from '../middleware/token-auth.js';

/** Dependencies of the admin routes. */
export interface AdminRouteDeps {
  /**
   * The daemon's own token. The route never touches the store graph,
   * so it needs nothing else from the runtime context.
   */
  readonly token: string;
  /** Called to shut the daemon down gracefully. */
  readonly requestShutdown: () => void;
}

/** Register the admin routes on the app. */
export function registerAdminRoutes(app: Hono, deps: AdminRouteDeps): void {
  app.post('/api/shutdown', c => {
    // Server administration, not a web/CLI session action: only the
    // daemon's own token may stop it, never a device-flow token.
    const provided = c.req.header('x-memhub-token') ?? '';
    if (!tokensEqual(provided, deps.token)) {
      throw forbidden(
        'shutdown_forbidden',
        'Shutting the daemon down requires the daemon token, not a device token'
      );
    }
    deps.requestShutdown();
    return c.json({ ok: true });
  });
}

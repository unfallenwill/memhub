/**
 * The web UI (read-only SPA) routes.
 *
 * The built SPA (web/dist) is served by the daemon itself. The routes
 * are registered LAST, so the API routes and the device-flow routes
 * keep priority over the catch-all wildcard.
 *
 * Static pages are token-exempt; when injectWebToken is set the page
 * itself carries the injected token for its /api calls (local daemons
 * only - remote deployments rely on device tokens from memhub login).
 */

import type { Hono } from 'hono';
import { webUiNotBuilt } from '../errors.js';
import { StaticSite, staticNotFound, staticResponse } from '../static.js';

/** Dependencies of the web UI routes. */
export interface WebRouteDeps {
  /**
   * Directory of the built web UI (web/dist). When undefined, the web
   * UI is disabled and no route is registered at all (JSON 404s).
   */
  readonly webDist?: string | undefined;
  /**
   * The API token injected into index.html. Empty when the page must
   * not carry a token (remote daemons).
   */
  readonly token: string;
  /**
   * Whether the served index.html may embed the daemon token. Only true
   * for loopback-bound daemons: on a remote host the page HTML must not
   * carry an all-powerful token (anyone who can open the page would get
   * one) - remote web sessions use `memhub login` device tokens instead.
   */
  readonly injectWebToken?: boolean | undefined;
}

/** Register the web UI routes on the app (after every other route). */
export function registerWebRoutes(app: Hono, deps: WebRouteDeps): void {
  if (deps.webDist === undefined) return;

  const site = new StaticSite(deps.webDist);
  const indexResponse = (): Response => {
    const index = site.index(deps.injectWebToken === false ? '' : deps.token);
    if (index === null) throw webUiNotBuilt();
    return staticResponse(index);
  };
  app.get('/', indexResponse);
  app.get('*', c => {
    // Direct /index.html requests get the token-injected page too
    // (same headers/CSP as /), never the raw placeholder file.
    if (c.req.path === '/index.html') return indexResponse();
    const file = site.file(c.req.path);
    if (file === null) throw staticNotFound(c.req.path);
    return staticResponse(file);
  });
}

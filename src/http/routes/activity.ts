/**
 * GET /api/activity - the read-only audit trail.
 *
 * The activity log is append-only: it is never purged, and the entries
 * are returned newest first with an id-based cursor.
 */

import type { Hono } from 'hono';
import { parseLimit, parseOptionalCursor } from '../validation.js';
import type { AppContext } from './deps.js';

/** Dependencies of the activity route. */
export interface ActivityRouteDeps {
  /** The slice of the runtime context the route reads from. */
  readonly context: AppContext;
}

/** Register the activity route on the app. */
export function registerActivityRoutes(app: Hono, deps: ActivityRouteDeps): void {
  const { cardService } = deps.context;

  app.get('/api/activity', c => {
    const cursor = parseOptionalCursor(c.req.query('cursor'));
    const limit = parseLimit(c.req.query('limit'), 50, 200);
    const page = cardService.listActivity(cursor, limit);
    return c.json({
      entries: page.entries.map(entry => ({
        id: entry.id,
        ts: entry.ts,
        actor: entry.actor,
        action: entry.action,
        card_id: entry.cardId,
        detail: entry.detail,
      })),
      next_cursor: page.nextCursor,
    });
  });
}

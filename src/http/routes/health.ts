/**
 * GET /healthz - the liveness/readiness probe of the daemon.
 *
 * The endpoint is token-exempt (it is used by supervisors and by the
 * CLI to find out whether the daemon is up), so it exposes counters
 * only, never card content.
 */

import type { Hono } from 'hono';
import { isIndexReady } from '../../core/policies/index-readiness.js';
import type { AppContext } from './deps.js';

/** Dependencies of the health route. */
export interface HealthRouteDeps {
  /** The slice of the runtime context the route reads from. */
  readonly context: AppContext;
  /** The daemon version (reported as-is). */
  readonly version: string;
  /** The daemon process id. */
  readonly pid: number;
  /** Wall-clock ms timestamp used to compute uptime. */
  readonly startedAt: number;
}

/** Register the health route on the app. */
export function registerHealthRoutes(app: Hono, deps: HealthRouteDeps): void {
  const { cardService, workerState } = deps.context;

  app.get('/healthz', c => {
    const cardStats = cardService.stats();
    const queueStats = cardService.pendingEvents();
    const model = workerState.getModel();
    return c.json({
      app: 'memhub',
      pid: deps.pid,
      uptime: Math.max(0, Math.floor((Date.now() - deps.startedAt) / 1000)),
      version: deps.version,
      cards: {
        total: cardStats.total,
        active: cardStats.active,
        pending_index: cardStats.pendingIndex,
      },
      queue: {
        pending_events: queueStats.pendingEvents,
        oldest_unindexed_age_s: cardStats.oldestUnindexedAgeS,
      },
      index: {
        ready: isIndexReady(deps.context.semantic, model, cardStats.pendingIndex),
        model,
      },
    });
  });
}

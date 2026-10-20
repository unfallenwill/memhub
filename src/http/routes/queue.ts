/**
 * GET /api/queue - the state of the background work.
 *
 * Two queues are reported: the event queue (the write path hands its
 * events over to the indexing worker) and the vector index backlog
 * (the cards that are stored but not embedded yet).
 */

import type { Hono } from 'hono';
import type { AppContext } from './deps.js';

/** Dependencies of the queue route. */
export interface QueueRouteDeps {
  /** The slice of the runtime context the route reads from. */
  readonly context: AppContext;
}

/** Register the queue route on the app. */
export function registerQueueRoutes(app: Hono, deps: QueueRouteDeps): void {
  const { cardService } = deps.context;

  app.get('/api/queue', c => {
    const cardStats = cardService.stats();
    const queueStats = cardService.pendingEvents();
    return c.json({
      pending_events: queueStats.pendingEvents,
      oldest_unprocessed_event_age_s: queueStats.oldestPendingEventAgeS,
      pending_index: cardStats.pendingIndex,
      oldest_unindexed_age_s: cardStats.oldestUnindexedAgeS,
    });
  });
}

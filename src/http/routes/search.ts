/**
 * POST /api/search - the unified retrieval endpoint.
 *
 * The route is a thin adapter: the mode routing (auto / keyword /
 * semantic), the result merging and the access bookkeeping all live in
 * the search service. The route only translates the two service errors
 * into their HTTP equivalents.
 */

import type { Hono } from 'hono';
import {
  IndexNotReadyError,
  SemanticStackNotInstalledError,
} from '../../services/search-service.js';
import { indexNotReady, semanticNotInstalled } from '../errors.js';
import { serializeCard } from '../mappers.js';
import { parseBody, searchSchema } from '../validation.js';
import type { AppContext } from './deps.js';

/** Dependencies of the search route. */
export interface SearchRouteDeps {
  /** The slice of the runtime context the route reads from. */
  readonly context: AppContext;
}

/** Register the search route on the app. */
export function registerSearchRoutes(app: Hono, deps: SearchRouteDeps): void {
  const searchService = deps.context.search;

  app.post('/api/search', async c => {
    const input = await parseBody(c, raw => searchSchema.parse(raw));
    let outcome;
    try {
      outcome = await searchService.search(input.query, input.mode, input.limit);
    } catch (error) {
      if (error instanceof IndexNotReadyError) {
        throw indexNotReady();
      }
      if (error instanceof SemanticStackNotInstalledError) {
        throw semanticNotInstalled();
      }
      throw error;
    }
    return c.json({
      results: outcome.results.map(item => ({
        ...serializeCard(item.card),
        score: item.score,
        matched_by: item.matchedBy,
      })),
      mode_used: outcome.modeUsed,
    });
  });
}

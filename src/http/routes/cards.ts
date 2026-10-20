/**
 * The card endpoints: /api/cards and /api/cards/:id.
 *
 * The write path stays constant-fast: a card is stored (and the search
 * index updated) in one transaction, and the response is sent right
 * away - the vector index is built asynchronously by the worker.
 *
 * The routes are thin adapters: they validate the request, call the
 * card service and translate its result into JSON. The lifecycle rules
 * (a card can only be superseded by a card that exists) live in the
 * service, not here.
 */

import type { Hono } from 'hono';
import { CARD_STATUSES, CARD_TYPES } from '../../core/domain/types.js';
import { invalidSupersedeTargetMessage } from '../../core/policies/card-lifecycle.js';
import { InvalidSupersedeTargetError } from '../../db/cards.js';
import { invalidRequest, notFound } from '../errors.js';
import { serializeCard } from '../mappers.js';
import {
  createCardSchema,
  invalidateSchema,
  parseBody,
  parseCardId,
  parseLimit,
  parseOptionalBody,
  parseOptionalCursor,
  parseOptionalEnum,
  updateCardSchema,
} from '../validation.js';
import type { AppContext } from './deps.js';

/** Dependencies of the card routes. */
export interface CardsRouteDeps {
  /** The slice of the runtime context the routes read from. */
  readonly context: AppContext;
}

/** Register the card routes on the app. */
export function registerCardRoutes(app: Hono, deps: CardsRouteDeps): void {
  const { cardService } = deps.context;

  app.post('/api/cards', async c => {
    const input = await parseBody(c, raw => createCardSchema.parse(raw));
    const result = cardService.createCard({
      title: input.title,
      body: input.body,
      type: input.type,
      cues: input.cues,
      confidence: input.confidence,
      writer: input.writer,
      source: input.source,
    });
    return c.json(
      { id: result.id, indexed: result.indexed, deduplicated: result.deduplicated },
      202
    );
  });

  app.get('/api/cards', c => {
    const status = parseOptionalEnum(c.req.query('status'), CARD_STATUSES, 'status');
    const type = parseOptionalEnum(c.req.query('type'), CARD_TYPES, 'type');
    const cursor = parseOptionalCursor(c.req.query('cursor'));
    const limit = parseLimit(c.req.query('limit'), 50, 200);
    const page = cardService.listCards({ status, type, cursor, limit });
    return c.json({
      cards: page.cards.map(serializeCard),
      next_cursor: page.nextCursor,
    });
  });

  app.get('/api/cards/:id', c => {
    const id = parseCardId(c.req.param('id'));
    const card = cardService.getCard(id);
    if (!card) throw notFound(`card ${id} not found`);
    return c.json({ card: serializeCard(card) });
  });

  app.patch('/api/cards/:id', async c => {
    const id = parseCardId(c.req.param('id'));
    const input = await parseBody(c, raw => updateCardSchema.parse(raw));
    const outcome = cardService.updateCard(id, {
      title: input.title,
      body: input.body,
      type: input.type,
      cues: input.cues,
      confidence: input.confidence,
    });
    if (!outcome.ok) throw notFound(`card ${id} not found`);
    return c.json({ card: serializeCard(outcome.card) });
  });

  app.delete('/api/cards/:id', c => {
    const id = parseCardId(c.req.param('id'));
    const outcome = cardService.archiveCard(id);
    if (!outcome.ok) throw notFound(`card ${id} not found`);
    return c.json({ card: serializeCard(outcome.card) });
  });

  app.post('/api/cards/:id/invalidate', async c => {
    const id = parseCardId(c.req.param('id'));
    const input = await parseOptionalBody(c, raw => invalidateSchema.parse(raw));
    if (input.card_id === id) {
      throw invalidRequest('a card cannot supersede itself');
    }
    try {
      const outcome = cardService.invalidateCard(id, input.card_id ?? null);
      if (!outcome.ok) {
        if (outcome.reason === 'invalid_target') {
          throw invalidRequest(invalidSupersedeTargetMessage(outcome.targetId));
        }
        throw notFound(`card ${id} not found`);
      }
      return c.json({ card: serializeCard(outcome.card) });
    } catch (error) {
      // The service checks the successor before the write, but the card
      // can still disappear between the two steps; the store reports
      // that as an invalid target.
      if (error instanceof InvalidSupersedeTargetError) {
        throw invalidRequest(error.message);
      }
      throw error;
    }
  });
}

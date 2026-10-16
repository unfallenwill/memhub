/**
 * Hono application with all MemHub HTTP routes.
 *
 * Security model (local threat model):
 * - Listens on 127.0.0.1 only (enforced by the daemon).
 * - Every request must have a Host header of localhost/127.0.0.1
 *   (DNS rebinding defense).
 * - Everything except GET /healthz requires a valid X-Memhub-Token.
 * - Errors use the unified {error:{code,message}} shape.
 */

import { timingSafeEqual } from 'crypto';
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import { ActivityLog } from '../db/activity.js';
import { CardStore, InvalidSupersedeTargetError } from '../db/cards.js';
import { EventStore } from '../db/events.js';
import { KeywordSearch } from '../db/search.js';
import { CARD_STATUSES, CARD_TYPES, SEARCH_MODES, type CardRecord } from '../db/types.js';
import { WorkerStateStore } from '../db/worker-state.js';
import { IndexNotReadyError, SearchService } from '../services/search-service.js';
import type { SemanticSearch } from '../services/semantic-search.js';
import {
  ApiError,
  indexNotReady,
  invalidHost,
  invalidRequest,
  notFound,
  unauthorized,
  webUiNotBuilt,
} from './errors.js';
import { StaticSite, staticNotFound, staticResponse } from './static.js';

/** Dependencies injected into the app (keeps it testable). */
export interface AppDeps {
  readonly db: DatabaseSync;
  readonly token: string;
  readonly version: string;
  readonly pid: number;
  /** Wall-clock ms timestamp used to compute uptime. */
  readonly startedAt: number;
  /** Called by POST /api/shutdown; the daemon closes itself gracefully. */
  readonly requestShutdown: () => void;
  /**
   * Semantic search backend. Null/undefined when the daemon runs without
   * a vector index; semantic mode then answers 503 and auto degrades to
   * keyword search.
   */
  readonly semantic?: SemanticSearch | undefined;
  /**
   * Directory of the built web UI (web/dist). When set, the SPA is served
   * at GET / with the API token injected into index.html; static assets
   * are token-exempt like the page itself. Null/undefined disables the
   * web UI (JSON 404s).
   */
  readonly webDist?: string | undefined;
}

const createCardSchema = z.object({
  title: z.string().min(1).max(2000),
  body: z.string().max(200_000),
  type: z.enum(CARD_TYPES),
  cues: z.array(z.string().min(1).max(200)).max(50).default([]),
  confidence: z.number().min(0).max(1).default(0.5),
  writer: z.string().min(1).max(200).optional(),
  source: z.string().min(1).max(200).optional(),
});

const updateCardSchema = z
  .object({
    title: z.string().min(1).max(2000).optional(),
    body: z.string().max(200_000).optional(),
    type: z.enum(CARD_TYPES).optional(),
    cues: z.array(z.string().min(1).max(200)).max(50).optional(),
    confidence: z.number().min(0).max(1).optional(),
  })
  .refine(value => Object.keys(value).length > 0, {
    message: 'At least one field must be provided',
  });

const searchSchema = z.object({
  query: z.string().min(1).max(2000),
  mode: z.enum(SEARCH_MODES).default('auto'),
  limit: z.number().int().min(1).max(100).default(10),
});

const invalidateSchema = z
  .object({
    card_id: z.number().int().positive().optional(),
  })
  .default({});

/** Build the MemHub HTTP application. */
export function createApp(deps: AppDeps): Hono {
  const events = new EventStore(deps.db);
  const activity = new ActivityLog(deps.db);
  const cards = new CardStore(deps.db, { events, activity });
  const search = new KeywordSearch(deps.db, cards);
  const workerState = new WorkerStateStore(deps.db);
  const searchService = new SearchService({
    cards,
    keyword: search,
    semantic: deps.semantic ?? null,
  });

  const app = new Hono();

  // DNS rebinding defense: only local Host headers are accepted.
  app.use('*', async (c, next) => {
    const host = c.req.header('host');
    if (!host || !isAllowedHost(host)) {
      throw invalidHost();
    }
    await next();
  });

  // Token auth for everything under /api/*.
  app.use('/api/*', async (c, next) => {
    const provided = c.req.header('x-memhub-token');
    if (provided === undefined || !tokensEqual(provided, deps.token)) {
      throw unauthorized();
    }
    await next();
  });

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

  app.get('/healthz', c => {
    const cardStats = cards.stats();
    const queueStats = events.stats();
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
        ready: isIndexReady(deps.semantic, model, cardStats.pendingIndex),
        model,
      },
    });
  });

  app.post('/api/shutdown', c => {
    deps.requestShutdown();
    return c.json({ ok: true });
  });

  app.post('/api/cards', async c => {
    const input = await parseBody(c, raw => createCardSchema.parse(raw));
    const result = cards.createCard({
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
    const page = cards.listCards({ status, type, cursor, limit });
    return c.json({
      cards: page.cards.map(serializeCard),
      next_cursor: page.nextCursor,
    });
  });

  app.get('/api/cards/:id', c => {
    const id = parseCardId(c.req.param('id'));
    const card = cards.getCard(id);
    if (!card) throw notFound(`card ${id} not found`);
    return c.json({ card: serializeCard(card) });
  });

  app.patch('/api/cards/:id', async c => {
    const id = parseCardId(c.req.param('id'));
    const input = await parseBody(c, raw => updateCardSchema.parse(raw));
    const card = cards.updateCard(id, {
      title: input.title,
      body: input.body,
      type: input.type,
      cues: input.cues,
      confidence: input.confidence,
    });
    if (!card) throw notFound(`card ${id} not found`);
    return c.json({ card: serializeCard(card) });
  });

  app.delete('/api/cards/:id', c => {
    const id = parseCardId(c.req.param('id'));
    const card = cards.archiveCard(id);
    if (!card) throw notFound(`card ${id} not found`);
    return c.json({ card: serializeCard(card) });
  });

  app.post('/api/cards/:id/invalidate', async c => {
    const id = parseCardId(c.req.param('id'));
    const input = await parseOptionalBody(c, raw => invalidateSchema.parse(raw));
    if (input.card_id === id) {
      throw invalidRequest('a card cannot supersede itself');
    }
    try {
      const card = cards.invalidateCard(id, input.card_id ?? null);
      if (!card) throw notFound(`card ${id} not found`);
      return c.json({ card: serializeCard(card) });
    } catch (error) {
      if (error instanceof InvalidSupersedeTargetError) {
        throw invalidRequest(error.message);
      }
      throw error;
    }
  });

  app.post('/api/search', async c => {
    const input = await parseBody(c, raw => searchSchema.parse(raw));
    let outcome;
    try {
      outcome = await searchService.search(input.query, input.mode, input.limit);
    } catch (error) {
      if (error instanceof IndexNotReadyError) {
        throw indexNotReady();
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

  app.get('/api/activity', c => {
    const cursor = parseOptionalCursor(c.req.query('cursor'));
    const limit = parseLimit(c.req.query('limit'), 50, 200);
    const page = activity.list(cursor, limit);
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

  app.get('/api/queue', c => {
    const cardStats = cards.stats();
    const queueStats = events.stats();
    return c.json({
      pending_events: queueStats.pendingEvents,
      oldest_unprocessed_event_age_s: queueStats.oldestPendingEventAgeS,
      pending_index: cardStats.pendingIndex,
      oldest_unindexed_age_s: cardStats.oldestUnindexedAgeS,
    });
  });

  // Web UI static hosting (registered last so /api routes keep priority).
  // Static pages are token-exempt; the page itself carries the injected
  // token for its /api calls. The Host check above still applies.
  if (deps.webDist !== undefined) {
    const site = new StaticSite(deps.webDist);
    app.get('/', () => {
      const index = site.index(deps.token);
      if (index === null) throw webUiNotBuilt();
      return staticResponse(index);
    });
    app.get('*', c => {
      const file = site.file(c.req.path);
      if (file === null) throw staticNotFound(c.req.path);
      return staticResponse(file);
    });
  }

  return app;
}

/**
 * Whether the vector index is ready for semantic search.
 * When a semantic backend is injected, its readiness flag is authoritative
 * (the daemon flips it once the worker loaded the model and the vector
 * table). Without one, fall back to the recorded model + pending counts.
 */
function isIndexReady(
  semantic: SemanticSearch | undefined,
  model: string | null,
  pendingIndex: number
): boolean {
  if (semantic !== undefined) {
    return semantic.ready;
  }
  return model !== null && pendingIndex === 0;
}

/** Allowed Host header hostnames (ports are ignored). */
function isAllowedHost(host: string): boolean {
  let hostname = host.trim().toLowerCase();
  if (hostname.startsWith('[')) {
    // IPv6 literal like [::1]:7800
    const end = hostname.indexOf(']');
    if (end === -1) return false;
    hostname = hostname.slice(0, end + 1);
    return hostname === '[::1]';
  }
  const colon = hostname.lastIndexOf(':');
  if (colon !== -1) {
    hostname = hostname.slice(0, colon);
  }
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/** Constant-time token comparison. */
function tokensEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf-8');
  const b = Buffer.from(expected, 'utf-8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Parse and validate a JSON request body with a zod schema.
 * The schema is applied via a callback so the parsed type stays concrete.
 */
async function parseBody<T>(
  c: { req: { json: () => Promise<unknown> } },
  parse: (raw: unknown) => T
): Promise<T> {
  const raw = await readJsonBody(c);
  return validate(parse, raw);
}

/** Like parseBody, but an empty or missing body counts as {}. */
async function parseOptionalBody<T>(
  c: { req: { json: () => Promise<unknown> } },
  parse: (raw: unknown) => T
): Promise<T> {
  let raw: unknown;
  try {
    raw = await readJsonBody(c);
  } catch {
    // An empty or malformed body is acceptable here: the body is optional.
    raw = {};
  }
  return validate(parse, raw);
}

function validate<T>(parse: (raw: unknown) => T, raw: unknown): T {
  try {
    return parse(raw);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const issue = error.issues[0];
      const path = issue.path.join('.');
      throw invalidRequest(path ? `${issue.message} (at ${path})` : issue.message);
    }
    throw error;
  }
}

async function readJsonBody(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw invalidRequest('request body must be valid JSON');
  }
}

function parseCardId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw invalidRequest('card id must be a positive integer');
  }
  return id;
}

function parseOptionalEnum<T extends readonly [string, ...string[]]>(
  raw: string | undefined,
  values: T,
  name: string
): T[number] | undefined {
  if (raw === undefined || raw === '') return undefined;
  const match = (values as readonly string[]).find(value => value === raw);
  if (match === undefined) {
    throw invalidRequest(`${name} must be one of: ${values.join(', ')}`);
  }
  return match as T[number];
}

function parseOptionalCursor(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw invalidRequest('cursor must be a positive integer');
  }
  return value;
}

function parseLimit(raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw invalidRequest(`limit must be an integer between 1 and ${max}`);
  }
  return value;
}

/** Serialize a card for API responses (camelCase, stable field order). */
export function serializeCard(card: CardRecord): Record<string, unknown> {
  return {
    id: card.id,
    title: card.title,
    body: card.body,
    type: card.type,
    cues: card.cues,
    confidence: card.confidence,
    writer: card.writer,
    source: card.source,
    status: card.status,
    merged_into: card.mergedInto,
    superseded_by: card.supersededBy,
    created_at: card.createdAt,
    updated_at: card.updatedAt,
    indexed_at: card.indexedAt,
    last_accessed_at: card.lastAccessedAt,
    hit_count: card.hitCount,
    archived_at: card.archivedAt,
  };
}

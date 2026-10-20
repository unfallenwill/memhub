/**
 * Request validation for the HTTP adapter.
 *
 * The schemas describe the accepted request bodies, the parse helpers
 * read the query parameters and the path parameters. Every failure is
 * reported as an ApiError with the code `invalid_request`, so the error
 * handler answers with the unified {error:{code,message}} shape.
 */

import { z } from 'zod';
import { CARD_TYPES, SEARCH_MODES } from '../core/domain/types.js';
import { invalidRequest } from './errors.js';

/** The body of POST /api/cards. */
export const createCardSchema = z.object({
  title: z.string().min(1).max(2000),
  body: z.string().max(200_000),
  type: z.enum(CARD_TYPES),
  cues: z.array(z.string().min(1).max(200)).max(50).default([]),
  confidence: z.number().min(0).max(1).default(0.5),
  writer: z.string().min(1).max(200).optional(),
  source: z.string().min(1).max(200).optional(),
});

/** The body of PATCH /api/cards/:id. */
export const updateCardSchema = z
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

/** The body of POST /api/search. */
export const searchSchema = z.object({
  query: z.string().min(1).max(2000),
  mode: z.enum(SEARCH_MODES).default('auto'),
  limit: z.number().int().min(1).max(100).default(10),
});

/** The body of POST /api/cards/:id/invalidate. */
export const invalidateSchema = z
  .object({
    card_id: z.number().int().positive().optional(),
  })
  .default({});

/**
 * Parse and validate a JSON request body with a zod schema.
 * The schema is applied via a callback so the parsed type stays concrete.
 */
export async function parseBody<T>(
  c: { req: { json: () => Promise<unknown> } },
  parse: (raw: unknown) => T
): Promise<T> {
  const raw = await readJsonBody(c);
  return validate(parse, raw);
}

/** Like parseBody, but an empty or missing body counts as {}. */
export async function parseOptionalBody<T>(
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

/** Run a schema and translate a zod error into an ApiError. */
export function validate<T>(parse: (raw: unknown) => T, raw: unknown): T {
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

/** Read the request body as JSON; a malformed body is a 400. */
export async function readJsonBody(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw invalidRequest('request body must be valid JSON');
  }
}

/** Parse a card id from the path; it must be a positive integer. */
export function parseCardId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw invalidRequest('card id must be a positive integer');
  }
  return id;
}

/** Parse an optional query parameter that must be one of `values`. */
export function parseOptionalEnum<T extends readonly [string, ...string[]]>(
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

/** Parse an optional cursor from the query; it must be a positive integer. */
export function parseOptionalCursor(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw invalidRequest('cursor must be a positive integer');
  }
  return value;
}

/** Parse an optional limit from the query; it must be within 1..max. */
export function parseLimit(raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw invalidRequest(`limit must be an integer between 1 and ${max}`);
  }
  return value;
}

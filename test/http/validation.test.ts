import { describe, expect, it } from 'vitest';
import { ApiError } from '../../src/http/errors.js';
import {
  createCardSchema,
  invalidateSchema,
  parseBody,
  parseCardId,
  parseLimit,
  parseOptionalBody,
  parseOptionalCursor,
  parseOptionalEnum,
  searchSchema,
  updateCardSchema,
  validate,
} from '../../src/http/validation.js';

/** A request context whose body is the given value. */
function body(raw: unknown): { req: { json: () => Promise<unknown> } } {
  return { req: { json: async () => raw } };
}

/** A request context whose body cannot be read. */
function brokenBody(): { req: { json: () => Promise<unknown> } } {
  return {
    req: {
      json: async () => {
        throw new SyntaxError('Unexpected token');
      },
    },
  };
}

/** Whether the thrown value is the expected kind of API error. */
function isApiError(error: unknown, status: number, code: string): boolean {
  return error instanceof ApiError && error.status === status && error.code === code;
}

describe('parseCardId', () => {
  it('accepts a positive integer', () => {
    expect(parseCardId('1')).toBe(1);
    expect(parseCardId('42')).toBe(42);
  });

  it('rejects zero', () => {
    expect(() => parseCardId('0')).toThrowError(ApiError);
  });

  it('rejects a negative id', () => {
    expect(() => parseCardId('-1')).toThrowError(ApiError);
  });

  it('rejects a fractional id', () => {
    expect(() => parseCardId('1.5')).toThrowError(ApiError);
  });

  it('rejects a non-numeric id', () => {
    expect(() => parseCardId('abc')).toThrowError(ApiError);
  });

  it('answers with invalid_request', () => {
    try {
      parseCardId('abc');
      expect.unreachable('parseCardId should have thrown');
    } catch (error) {
      expect(isApiError(error, 400, 'invalid_request')).toBe(true);
      expect((error as ApiError).message).toContain('card id must be a positive integer');
    }
  });
});

describe('parseLimit', () => {
  it('falls back when the parameter is missing or empty', () => {
    expect(parseLimit(undefined, 50, 200)).toBe(50);
    expect(parseLimit('', 50, 200)).toBe(50);
  });

  it('accepts a limit within the range', () => {
    expect(parseLimit('1', 50, 200)).toBe(1);
    expect(parseLimit('200', 50, 200)).toBe(200);
  });

  it('rejects zero', () => {
    expect(() => parseLimit('0', 50, 200)).toThrowError(ApiError);
  });

  it('rejects a limit above the maximum', () => {
    expect(() => parseLimit('201', 50, 200)).toThrowError(ApiError);
  });

  it('rejects a non-numeric limit', () => {
    expect(() => parseLimit('abc', 50, 200)).toThrowError(ApiError);
  });

  it('rejects a fractional limit', () => {
    expect(() => parseLimit('1.5', 50, 200)).toThrowError(ApiError);
  });

  it('answers with invalid_request', () => {
    try {
      parseLimit('abc', 50, 200);
      expect.unreachable('parseLimit should have thrown');
    } catch (error) {
      expect(isApiError(error, 400, 'invalid_request')).toBe(true);
      expect((error as ApiError).message).toContain('limit must be an integer between 1 and 200');
    }
  });
});

describe('parseOptionalCursor', () => {
  it('returns null for a missing or empty cursor', () => {
    expect(parseOptionalCursor(undefined)).toBeNull();
    expect(parseOptionalCursor('')).toBeNull();
  });

  it('accepts a positive integer', () => {
    expect(parseOptionalCursor('7')).toBe(7);
  });

  it('rejects zero, a negative and a non-numeric cursor', () => {
    expect(() => parseOptionalCursor('0')).toThrowError(ApiError);
    expect(() => parseOptionalCursor('-3')).toThrowError(ApiError);
    expect(() => parseOptionalCursor('abc')).toThrowError(ApiError);
  });
});

describe('parseOptionalEnum', () => {
  const values = ['active', 'archived'] as const;

  it('returns undefined for a missing or empty value', () => {
    expect(parseOptionalEnum(undefined, values, 'status')).toBeUndefined();
    expect(parseOptionalEnum('', values, 'status')).toBeUndefined();
  });

  it('accepts one of the allowed values', () => {
    expect(parseOptionalEnum('active', values, 'status')).toBe('active');
    expect(parseOptionalEnum('archived', values, 'status')).toBe('archived');
  });

  it('rejects an unknown value', () => {
    expect(() => parseOptionalEnum('deleted', values, 'status')).toThrowError(ApiError);
  });

  it('is case sensitive', () => {
    expect(() => parseOptionalEnum('ACTIVE', values, 'status')).toThrowError(ApiError);
  });

  it('names the parameter and the allowed values in the message', () => {
    try {
      parseOptionalEnum('deleted', values, 'status');
      expect.unreachable('parseOptionalEnum should have thrown');
    } catch (error) {
      expect(isApiError(error, 400, 'invalid_request')).toBe(true);
      expect((error as ApiError).message).toBe('status must be one of: active, archived');
    }
  });
});

describe('validate', () => {
  it('returns the parsed value when the schema accepts it', () => {
    expect(validate(raw => raw as { a: number }, { a: 1 })).toEqual({ a: 1 });
  });

  it('turns a zod error into invalid_request with the path', () => {
    try {
      validate(raw => createCardSchema.parse(raw), { title: '', body: 'b', type: 'fact' });
      expect.unreachable('validate should have thrown');
    } catch (error) {
      expect(isApiError(error, 400, 'invalid_request')).toBe(true);
      expect((error as ApiError).message).toContain('(at title)');
    }
  });

  it('reports the path of a nested field', () => {
    try {
      validate(raw => createCardSchema.parse(raw), {
        title: 't',
        body: 'b',
        type: 'fact',
        cues: ['ok', 42],
      });
      expect.unreachable('validate should have thrown');
    } catch (error) {
      expect((error as ApiError).message).toContain('(at cues.1)');
    }
  });

  it('lets other errors through', () => {
    expect(() =>
      validate(() => {
        throw new TypeError('boom');
      }, {})
    ).toThrowError(TypeError);
  });
});

describe('parseBody', () => {
  it('parses a valid body', async () => {
    const parsed = await parseBody(body({ title: 't', body: 'b', type: 'fact' }), raw =>
      createCardSchema.parse(raw)
    );

    expect(parsed.title).toBe('t');
    expect(parsed.cues).toEqual([]);
    expect(parsed.confidence).toBe(0.5);
  });

  it('rejects a malformed body', async () => {
    await expect(parseBody(brokenBody(), raw => createCardSchema.parse(raw))).rejects.toThrowError(
      ApiError
    );
  });

  it('answers invalid_request for a malformed body', async () => {
    const error = await parseBody(brokenBody(), raw => createCardSchema.parse(raw)).catch(
      caught => caught
    );

    expect(isApiError(error, 400, 'invalid_request')).toBe(true);
    expect((error as ApiError).message).toBe('request body must be valid JSON');
  });
});

describe('parseOptionalBody', () => {
  it('treats a missing body as an empty object', async () => {
    const parsed = await parseOptionalBody(brokenBody(), raw => invalidateSchema.parse(raw));

    expect(parsed).toEqual({});
  });

  it('parses a given body', async () => {
    const parsed = await parseOptionalBody(body({ card_id: 7 }), raw =>
      invalidateSchema.parse(raw)
    );

    expect(parsed.card_id).toBe(7);
  });
});

describe('the request schemas', () => {
  it('requires at least one field in an update', () => {
    expect(() => updateCardSchema.parse({})).toThrowError();
    expect(updateCardSchema.parse({ title: 't' }).title).toBe('t');
  });

  it('defaults the search mode and the limit', () => {
    const parsed = searchSchema.parse({ query: 'needle' });

    expect(parsed.mode).toBe('auto');
    expect(parsed.limit).toBe(10);
  });

  it('rejects an unknown search mode', () => {
    expect(() => searchSchema.parse({ query: 'needle', mode: 'fuzzy' })).toThrowError();
  });

  it('rejects an unknown card type', () => {
    expect(() => createCardSchema.parse({ title: 't', body: 'b', type: 'gossip' })).toThrowError();
  });
});

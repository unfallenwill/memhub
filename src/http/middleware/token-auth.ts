/**
 * Token authentication for the API routes.
 *
 * Every request below /api/* carries an X-Memhub-Token header: either
 * the daemon's own token (file or environment) or a device-flow token
 * minted by `memhub login`. The comparison is constant-time; a wrong
 * token is answered with 401 before the route runs.
 */

import { timingSafeEqual } from 'crypto';
import type { MiddlewareHandler } from 'hono';
import type { DeviceTokenRepository } from '../../core/ports/repositories.js';
import { tokenHash } from '../../db/device-tokens.js';
import { unauthorized } from '../errors.js';

/** How often a device token's last-used timestamp is written at most. */
export const TOUCH_INTERVAL_MS = 60_000;

/** Constant-time token comparison. */
export function tokensEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf-8');
  const b = Buffer.from(expected, 'utf-8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Dependencies of the token middleware. */
export interface TokenAuthOptions {
  /** The daemon's own token. */
  readonly token: string;
  /** The store of the device-flow tokens. */
  readonly deviceTokens: DeviceTokenRepository;
}

/**
 * Build the token middleware.
 *
 * The last-used timestamp of a device token is written at most once a
 * minute: one indexed read per request, a write at most once a minute
 * per token (the write path stays fast).
 */
export function createTokenAuth(options: TokenAuthOptions): MiddlewareHandler {
  const { token, deviceTokens } = options;
  return async (c, next) => {
    const provided = c.req.header('x-memhub-token');
    if (provided === undefined) throw unauthorized();
    if (!tokensEqual(provided, token)) {
      const record = deviceTokens.findActiveByHash(tokenHash(provided));
      if (record === null) throw unauthorized();
      // Throttled last-used update: one indexed read per request, a
      // write at most once a minute per token (write path stays fast).
      if (
        record.lastUsedAt === null ||
        Date.now() - Date.parse(record.lastUsedAt) > TOUCH_INTERVAL_MS
      ) {
        deviceTokens.touchLastUsed(record.id);
      }
    }
    await next();
  };
}

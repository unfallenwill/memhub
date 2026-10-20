/**
 * The Host header guard (DNS rebinding defense).
 *
 * Every request must carry a Host header this daemon is willing to
 * answer. The local defaults (localhost, 127.0.0.1, [::1]) are only
 * accepted when the request actually originates from this machine; any
 * other host must be listed explicitly (MEMHUB_ALLOWED_HOSTS), and a
 * single "*" entry accepts everything.
 */

import type { MiddlewareHandler } from 'hono';
import { invalidHost } from '../errors.js';
import { isLocalConnection } from './request-info.js';

/**
 * Whether a Host header value is allowed: the local defaults (only for
 * connections that actually originate from this machine) plus any
 * configured extra hosts (case-insensitive, ports ignored). A "*" entry
 * in the extras accepts everything.
 */
export function isAllowedHost(
  host: string,
  extra: readonly string[],
  localConnection: boolean
): boolean {
  if (extra.includes('*')) return true;
  let hostname = host.trim().toLowerCase();
  if (hostname.startsWith('[')) {
    // IPv6 literal like [::1]:7800
    const end = hostname.indexOf(']');
    if (end === -1) return false;
    hostname = hostname.slice(0, end + 1);
    return (
      (localConnection && hostname === '[::1]') ||
      extra.some(entry => entry.toLowerCase() === hostname)
    );
  }
  const colon = hostname.lastIndexOf(':');
  if (colon !== -1) {
    hostname = hostname.slice(0, colon);
  }
  if (localConnection && (hostname === 'localhost' || hostname === '127.0.0.1')) return true;
  return extra.some(entry => entry.toLowerCase() === hostname);
}

/**
 * Build the Host guard middleware.
 *
 * @param allowedHosts Additional Host header values accepted besides the
 *   local defaults. A single "*" accepts every Host header.
 */
export function createHostGuard(allowedHosts: readonly string[]): MiddlewareHandler {
  return async (c, next) => {
    const host = c.req.header('host');
    if (!host || !isAllowedHost(host, allowedHosts, isLocalConnection(c))) {
      throw invalidHost();
    }
    await next();
  };
}

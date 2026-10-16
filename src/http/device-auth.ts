/**
 * OAuth 2.1 device authorization flow (RFC 8628 subset).
 *
 * `memhub login` on a device asks POST /oauth/device/code for a grant,
 * opens the browser at /login (where the user proves knowledge of the
 * admin password — or sets it on the very first login), then polls
 * POST /oauth/device/token until the grant is approved and an access
 * token is handed out. Tokens live in device_tokens (hash only) and
 * are accepted by the /api/* middleware like the legacy token.
 *
 * Security posture: no cookies or sessions (CSRF-free by design),
 * constant-time comparisons, generic errors that never reveal which
 * field was wrong, per-IP sliding-window limits, and a fixed set of
 * redirect targets (no open redirect, no input echoed into Location).
 */

import { randomBytes, timingSafeEqual } from 'crypto';
import type { Context } from 'hono';
import type { Hono } from 'hono';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { DeviceTokenStore, tokenHash } from '../db/device-tokens.js';
import { AdminPasswordStore, hashPassword, verifyPassword } from '../daemon/admin-password.js';
import { invalidRequest, notFound } from './errors.js';
import { LOGIN_PAGE_HEADERS, renderLoginPage, type LoginPageState } from './login-page.js';
import { RateLimiter } from './rate-limiter.js';

/** How long an unapproved device grant stays valid. */
export const DEVICE_CODE_TTL_S = 300;

/** Required poll interval (seconds) advertised to the CLI. */
export const POLL_INTERVAL_S = 5;

/** Maximum password attempts per grant before it is denied. */
export const MAX_ATTEMPTS = 3;

/** Crockford base32 — no I/L/O/U to avoid transcription confusion. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Prefix shared by every RFC 8628 error response body. */
function oauthError(error: string, description: string, status: number): Response {
  return Response.json({ error, error_description: description }, { status });
}

/** Generate a user code like "7Q3K-M2XW" (40 bits of entropy). */
export function generateUserCode(): string {
  const bytes = randomBytes(16);
  const chars: string[] = [];
  for (let i = 0; i < 8; i++) {
    // Rejection sampling would be exact; 256 % 32 === 0 so direct
    // indexing is unbiased for this alphabet size.
    chars.push(CROCKFORD[bytes[i] % 32]);
  }
  return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
}

/**
 * Normalize a typed user code: uppercase, drop non-alphanumerics, apply
 * Crockford confusable mapping (I/L→1, O→0). Returns the canonical
 * 8-char value (no hyphen) or null when it cannot be 8 chars.
 */
export function normalizeUserCode(input: string): string | null {
  const cleaned = input
    .toUpperCase()
    .replaceAll('I', '1')
    .replaceAll('L', '1')
    .replaceAll('O', '0')
    .replace(/[^0-9A-Z]/g, '');
  if (cleaned.length !== 8) return null;
  return cleaned;
}

/** Constant-time compare of two equal-length secret strings. */
function secretsEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf-8');
  const bufB = Buffer.from(b, 'utf-8');
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/** Lifecycle state of a device grant. */
export type DeviceGrantStatus = 'pending' | 'approved' | 'denied';

/** An in-flight device authorization grant. */
export interface DeviceGrant {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly label: string;
  readonly expiresAt: number;
  status: DeviceGrantStatus;
  attempts: number;
  lastPollAt: number;
  /** The minted access token, set when the grant is approved. */
  accessToken: string | null;
}

/** Options for DeviceGrantStore. */
export interface DeviceGrantStoreOptions {
  readonly ttlMs: number;
  readonly maxPending: number;
  readonly now?: (() => number) | undefined;
}

/** In-memory grants; lost on restart (in-flight logins retry cleanly). */
export class DeviceGrantStore {
  private readonly grants = new Map<string, DeviceGrant>();

  constructor(private readonly options: DeviceGrantStoreOptions) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** Create a new pending grant; null when capacity is exhausted. */
  create(label: string): DeviceGrant | null {
    this.pruneExpired();
    if (this.grants.size >= this.options.maxPending) return null;
    const grant: DeviceGrant = {
      deviceCode: randomBytes(32).toString('hex'),
      userCode: generateUserCode(),
      label,
      expiresAt: this.now() + this.options.ttlMs,
      status: 'pending',
      attempts: 0,
      lastPollAt: 0,
      accessToken: null,
    };
    this.grants.set(grant.deviceCode, grant);
    return grant;
  }

  /** Find a grant by its (secret) device code; expired grants count as gone. */
  findByDeviceCode(deviceCode: string): DeviceGrant | null {
    const grant = this.grants.get(deviceCode);
    if (grant === undefined || grant.expiresAt <= this.now()) return null;
    return grant;
  }

  /**
   * Find a pending grant by user code. The stored codes carry a hyphen;
   * both sides are normalized (Crockford mapping) before a
   * constant-time comparison.
   */
  findPendingByUserCode(userCode: string): DeviceGrant | null {
    const normalized = normalizeUserCode(userCode);
    if (normalized === null) return null;
    let match: DeviceGrant | null = null;
    for (const grant of this.grants.values()) {
      if (grant.status !== 'pending' || grant.expiresAt <= this.now()) continue;
      if (secretsEqual(normalizeUserCode(grant.userCode) ?? '', normalized)) match = grant;
    }
    return match;
  }

  /** Remove a grant (after its token was claimed). */
  delete(grant: DeviceGrant): void {
    this.grants.delete(grant.deviceCode);
  }

  /** Drop expired grants. */
  pruneExpired(): void {
    const now = this.now();
    for (const [deviceCode, grant] of this.grants) {
      if (grant.expiresAt <= now) this.grants.delete(deviceCode);
    }
  }
}

/** Limits for the device flow endpoints. */
export interface DeviceAuthLimits {
  /** Failed authorize attempts per IP per window. */
  readonly authorizeFailuresPerMin: number;
  /** device/code requests per IP per window. */
  readonly codeRequestsPerMin: number;
}

const DEFAULT_LIMITS: DeviceAuthLimits = {
  authorizeFailuresPerMin: 5,
  codeRequestsPerMin: 30,
};

/** Dependencies for registerDeviceAuthRoutes. */
export interface DeviceAuthDeps {
  readonly db: DatabaseSync;
  readonly legacyToken: string;
  /** Built web dist directory; when set, approval redirects into the SPA. */
  readonly webDist?: string | undefined;
  readonly now?: (() => number) | undefined;
  readonly limits?: Partial<DeviceAuthLimits> | undefined;
}

const CLIENT_ID = 'memhub-cli';
const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';
const MAX_BODY_BYTES = 4096;

const deviceCodeSchema = z.object({
  client_id: z.literal(CLIENT_ID),
  base_url: z
    .string()
    .max(2000)
    .refine(
      value => {
        try {
          const url = new URL(value);
          return url.protocol === 'http:' || url.protocol === 'https:';
        } catch {
          return false;
        }
      },
      { message: 'base_url must be an http(s) URL' }
    )
    .optional(),
  label: z.string().min(1).max(100).optional(),
});

const deviceTokenSchema = z.object({
  grant_type: z.literal(DEVICE_GRANT_TYPE),
  device_code: z.string().min(1).max(128),
  client_id: z.literal(CLIENT_ID),
});

/** Best-effort remote address of the request (never trusts XFF). */
function remoteAddressOf(c: Context): string {
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)
    ?.incoming;
  return incoming?.socket?.remoteAddress ?? 'unknown';
}

/** Validate and normalize a client-provided base_url. */
function normalizeBaseUrl(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** The verification URL for a grant, preferring the CLI-provided base. */
function verificationUrl(
  base: string | null,
  hostHeader: string | undefined,
  userCode: string
): {
  uri: string;
  complete: string;
} {
  const origin = base ?? `http://${hostHeader ?? 'localhost'}`;
  return {
    uri: `${origin}/login`,
    complete: `${origin}/login?code=${encodeURIComponent(userCode)}`,
  };
}

/** Short HTML response for non-JSON error paths. */
function htmlResponse(html: string, status: number): Response {
  return new Response(html, { status, headers: LOGIN_PAGE_HEADERS });
}

/** Whether the request body is within the size guard. */
function bodyTooLarge(c: Context): boolean {
  const length = c.req.header('content-length');
  if (length === undefined) return false;
  return Number(length) > MAX_BODY_BYTES;
}

/** Register all device-flow routes on the app (before the SPA wildcard). */
export function registerDeviceAuthRoutes(app: Hono, deps: DeviceAuthDeps): void {
  const adminAuth = new AdminPasswordStore(deps.db);
  const deviceTokens = new DeviceTokenStore(deps.db);
  const grants = new DeviceGrantStore({
    ttlMs: DEVICE_CODE_TTL_S * 1000,
    maxPending: 1000,
    now: deps.now,
  });
  const limits = { ...DEFAULT_LIMITS, ...deps.limits };
  const now = (): number => deps.now?.() ?? Date.now();
  const authorizeLimiter = new RateLimiter({
    windowMs: 60_000,
    max: limits.authorizeFailuresPerMin,
    now,
  });
  const codeLimiter = new RateLimiter({ windowMs: 60_000, max: limits.codeRequestsPerMin, now });

  app.post('/oauth/device/code', async c => {
    if (bodyTooLarge(c)) return oauthError('invalid_request', 'request body too large', 400);
    const limit = codeLimiter.hit(remoteAddressOf(c));
    if (!limit.allowed) {
      return oauthError('slow_down', `try again in ${limit.retryAfterS}s`, 429);
    }
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return oauthError('invalid_request', 'request body must be valid JSON', 400);
    }
    const parsed = deviceCodeSchema.safeParse(raw);
    if (!parsed.success) {
      return oauthError('invalid_request', 'invalid device authorization request', 400);
    }
    const grant = grants.create(parsed.data.label ?? 'cli');
    if (grant === null) {
      return oauthError('slow_down', 'too many pending authorizations', 429);
    }
    const uri = verificationUrl(
      normalizeBaseUrl(parsed.data.base_url),
      c.req.header('host'),
      grant.userCode
    );
    return c.json({
      device_code: grant.deviceCode,
      user_code: grant.userCode,
      verification_uri: uri.uri,
      verification_uri_complete: uri.complete,
      expires_in: DEVICE_CODE_TTL_S,
      interval: POLL_INTERVAL_S,
      requires_setup: adminAuth.get() === null,
    });
  });

  app.get('/login', c => {
    const initialized = adminAuth.get() !== null;
    const code = c.req.query('code');
    const error = c.req.query('error');
    const done = c.req.query('done');
    let state: LoginPageState;
    if (error === 'invalid' || error === 'denied' || error === 'missing') {
      state = `error_${error}` as LoginPageState;
    } else if (done === '1') {
      state = 'success';
    } else if (!initialized) {
      state = 'setup';
    } else {
      state = 'login';
    }
    // Uninitialized access without a matching pending grant cannot set
    // a password: the first login must be started from the owner's CLI.
    if (state === 'setup') {
      const hasGrant = code !== undefined && grants.findPendingByUserCode(code) !== null;
      if (!hasGrant) state = 'not_initialized_bare';
    }
    return htmlResponse(
      renderLoginPage({
        prefilledCode: code === '' ? undefined : code,
        state,
        initialized,
      }),
      200
    );
  });

  app.post('/oauth/device/authorize', async c => {
    if (bodyTooLarge(c)) return htmlResponse('request body too large', 400);
    const limit = authorizeLimiter.hit(remoteAddressOf(c));
    if (!limit.allowed) {
      return htmlResponse('too many attempts, wait a minute', 429);
    }
    let form: URLSearchParams;
    try {
      form = new URLSearchParams(await c.req.text());
    } catch {
      return redirectLogin(c, null, 'invalid');
    }
    const userCodeRaw = form.get('user_code') ?? '';
    const password = form.get('password') ?? '';
    const confirm = form.get('password_confirm');
    const grant = grants.findPendingByUserCode(userCodeRaw);
    if (grant === null) return redirectLogin(c, null, 'missing');
    const initialized = adminAuth.get() !== null;

    let ok: boolean;
    if (!initialized) {
      // First login: set the admin password. Both inputs must match and
      // meet the minimum length; on success the password is stored and
      // this grant approves the setting device.
      ok =
        confirm !== null && confirm === password && password.length >= 8 && password.length <= 1024;
      if (ok) {
        try {
          adminAuth.set(hashPassword(password));
        } catch (error) {
          console.error('memhub: failed to store admin password:', error);
          return redirectLogin(c, grant.userCode, 'invalid');
        }
      }
    } else {
      ok =
        password.length <= 1024 && (await verifyPassword(password, adminAuth.get()!.passwordHash));
    }

    if (!ok) {
      grant.attempts += 1;
      if (grant.attempts >= MAX_ATTEMPTS) {
        grant.status = 'denied';
        return redirectLogin(c, grant.userCode, 'denied');
      }
      return redirectLogin(c, grant.userCode, 'invalid');
    }

    // Approve: mint the token, persist its hash, hand it to both the
    // browser (hash fragment redirect) and the polling CLI.
    const token = randomBytes(32).toString('hex');
    deviceTokens.create(tokenHash(token), grant.label);
    grant.status = 'approved';
    grant.accessToken = token;
    if (deps.webDist !== undefined) {
      return c.redirect(`/#token=${encodeURIComponent(token)}`);
    }
    return redirectLogin(c, null, undefined, 'done');
  });

  app.post('/oauth/device/token', async c => {
    if (bodyTooLarge(c)) return oauthError('invalid_request', 'request body too large', 400);
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return oauthError('invalid_request', 'request body must be valid JSON', 400);
    }
    const parsed = deviceTokenSchema.safeParse(raw);
    if (!parsed.success) {
      // Distinguish a wrong grant_type from other malformed requests.
      const grantType =
        raw !== null && typeof raw === 'object' && 'grant_type' in raw
          ? String((raw as { grant_type: unknown }).grant_type)
          : '';
      if (grantType !== '' && grantType !== DEVICE_GRANT_TYPE) {
        return oauthError('unsupported_grant_type', 'only the device code grant is supported', 400);
      }
      return oauthError('invalid_request', 'invalid token request', 400);
    }
    const grant = grants.findByDeviceCode(parsed.data.device_code);
    // Unknown, expired and consumed codes are indistinguishable on
    // purpose: no oracle for probing valid device codes.
    if (grant === null) {
      return oauthError(
        'expired_token',
        'the device code is unknown, expired or already used',
        400
      );
    }
    const pollNow = now();
    const minIntervalMs = POLL_INTERVAL_S * 1000 * 0.75;
    if (grant.lastPollAt !== 0 && pollNow - grant.lastPollAt < minIntervalMs) {
      grant.lastPollAt = pollNow;
      return oauthError('slow_down', 'polling too frequently', 400);
    }
    grant.lastPollAt = pollNow;
    if (grant.status === 'denied') {
      grants.delete(grant);
      return oauthError('access_denied', 'authorization was denied', 400);
    }
    if (grant.status !== 'approved' || grant.accessToken === null) {
      return oauthError('authorization_pending', 'the user has not yet approved the request', 400);
    }
    const token = grant.accessToken;
    grants.delete(grant);
    return c.json({ access_token: token, token_type: 'Bearer' });
  });

  // --- Authenticated device management (house error shape, under /api). ---

  app.delete('/api/auth/token', c => {
    const provided = c.req.header('x-memhub-token') ?? '';
    if (provided !== '' && secretsEqual(provided, deps.legacyToken)) {
      throw invalidRequest('this token belongs to the daemon itself; revoke device tokens instead');
    }
    const record = deviceTokens.findActiveByHash(tokenHash(provided));
    if (record === null) throw invalidRequest('no device token matched this request');
    deviceTokens.revoke(record.id);
    return c.json({ ok: true });
  });

  app.get('/api/auth/devices', c => {
    const provided = c.req.header('x-memhub-token') ?? '';
    const current =
      provided !== '' && !secretsEqual(provided, deps.legacyToken)
        ? deviceTokens.findActiveByHash(tokenHash(provided))
        : null;
    return c.json({
      devices: deviceTokens.list().map(device => ({
        id: device.id,
        label: device.label,
        created_at: device.createdAt,
        last_used_at: device.lastUsedAt,
        revoked_at: device.revokedAt,
        current: current !== null && current.id === device.id,
      })),
    });
  });

  app.delete('/api/auth/devices/:id', c => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0)
      throw invalidRequest('device id must be a positive integer');
    if (!deviceTokens.revoke(id)) throw notFound(`device ${id} not found`);
    return c.json({ ok: true });
  });
}

/** 302 to /login with a fixed status fragment; never echoes user input. */
function redirectLogin(
  c: Context,
  userCode: string | null,
  error: 'invalid' | 'denied' | 'missing' | undefined,
  done?: 'done'
): Response {
  const params = new URLSearchParams();
  if (error !== undefined) params.set('error', error);
  if (done !== undefined) params.set('done', '1');
  // The user code is server-generated (Crockford alphabet); returning it
  // keeps the retry form prefilled. Escaped again at render time.
  if (userCode !== null && error !== undefined) params.set('code', userCode);
  const query = params.toString();
  return c.redirect(query === '' ? '/login' : `/login?${query}`, 302);
}

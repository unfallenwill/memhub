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
 *
 * The module also owns the device management endpoints under /api/auth
 * (list and revoke the device tokens).
 */

import { randomBytes } from 'crypto';
import type { Context } from 'hono';
import type { Hono } from 'hono';
import { z } from 'zod';
import { hashPassword, verifyPassword } from '../../auth/admin-password.js';
import { DeviceGrantStore, secretsEqual } from '../../auth/device-grants.js';
import { normalizeSetupCode } from '../../auth/setup-code.js';
import { tokenHash } from '../../db/device-tokens.js';
import type {
  AdminPasswordRepository,
  DeviceTokenRepository,
} from '../../core/ports/repositories.js';
import { invalidRequest, notFound } from '../errors.js';
import { LOGIN_PAGE_HEADERS, renderLoginPage, type LoginPageState } from '../login-page.js';
import { RateLimiter } from '../rate-limiter.js';
import { remoteAddressOf } from '../middleware/request-info.js';
import type { AppDeps } from './deps.js';

// The grant primitives moved to src/auth/ (shared with the daemon);
// they are re-exported here so the HTTP layer keeps its public surface.
export {
  DeviceGrantStore,
  generateUserCode,
  normalizeUserCode,
  type DeviceGrant,
  type DeviceGrantStatus,
  type DeviceGrantStoreOptions,
} from '../../auth/device-grants.js';

/** How long an unapproved device grant stays valid. */
export const DEVICE_CODE_TTL_S = 300;

/** Required poll interval (seconds) advertised to the CLI. */
export const POLL_INTERVAL_S = 5;

/** Maximum password attempts per grant before it is denied. */
export const MAX_ATTEMPTS = 3;

/** Prefix shared by every RFC 8628 error response body. */
function oauthError(error: string, description: string, status: number): Response {
  return Response.json({ error, error_description: description }, { status });
}

/** Limits for the device flow endpoints. */
export interface DeviceAuthLimits {
  /** Failed authorize attempts per IP per window. */
  readonly authorizeFailuresPerMin: number;
  /** device/code requests per IP per window. */
  readonly codeRequestsPerMin: number;
  /** Pending grants a single address may hold at once. */
  readonly pendingGrantsPerIp: number;
}

const DEFAULT_LIMITS: DeviceAuthLimits = {
  authorizeFailuresPerMin: 5,
  codeRequestsPerMin: 30,
  pendingGrantsPerIp: 10,
};

/** Dependencies for registerDeviceAuthRoutes. */
export interface DeviceAuthDeps {
  /** Device-flow tokens (from the composition root). */
  readonly deviceTokens: DeviceTokenRepository;
  /** The admin password (from the composition root). */
  readonly adminPassword: AdminPasswordRepository;
  readonly legacyToken: string;
  /** Built web dist directory; when set, approval redirects into the SPA. */
  readonly webDist?: string | undefined;
  readonly now?: (() => number) | undefined;
  readonly limits?: Partial<DeviceAuthLimits> | undefined;
  /**
   * Lazily supplies the first-run setup code; called only while the
   * admin password is unset, so `memhub reset-password` (which clears
   * the password) re-enables setup without a daemon restart. Returns
   * null when no code is available — the first-login setup is then
   * refused. Without this check anyone on the network could set the
   * admin password of a fresh deployment and take it over.
   */
  readonly getSetupCode?: (() => string | null) | undefined;
  /** Path of the setup code file on the server (shown on the login page). */
  readonly setupCodePath?: string | undefined;
  /** Called after the admin password was set through the setup flow. */
  readonly onSetupComplete?: (() => void) | undefined;
}

const CLIENT_ID = 'memhub-cli';
const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

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

/**
 * The device-flow dependencies of a running app.
 *
 * The route module keeps its own dependency contract (DeviceAuthDeps);
 * this factory wires the composition root to it.
 */
export function deviceAuthDeps(deps: AppDeps): DeviceAuthDeps {
  return {
    deviceTokens: deps.context.deviceTokens,
    adminPassword: deps.context.adminPassword,
    legacyToken: deps.token,
    webDist: deps.webDist,
    now: deps.authNow,
    getSetupCode: deps.getSetupCode,
    setupCodePath: deps.setupCodePath,
    onSetupComplete: deps.onSetupComplete,
  };
}

/** Register all device-flow routes on the app (before the SPA wildcard). */
export function registerDeviceAuthRoutes(app: Hono, deps: DeviceAuthDeps): void {
  const adminAuth = deps.adminPassword;
  const deviceTokens = deps.deviceTokens;
  const limits = { ...DEFAULT_LIMITS, ...deps.limits };
  const grants = new DeviceGrantStore({
    ttlMs: DEVICE_CODE_TTL_S * 1000,
    maxPending: 1000,
    maxPendingPerIp: limits.pendingGrantsPerIp,
    now: deps.now,
  });
  const now = (): number => deps.now?.() ?? Date.now();
  const authorizeLimiter = new RateLimiter({
    windowMs: 60_000,
    max: limits.authorizeFailuresPerMin,
    now,
  });
  const codeLimiter = new RateLimiter({ windowMs: 60_000, max: limits.codeRequestsPerMin, now });

  app.post('/oauth/device/code', async c => {
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
    const grant = grants.create(parsed.data.label ?? 'cli', remoteAddressOf(c));
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
        setupCodePath: deps.setupCodePath,
      }),
      200
    );
  });

  app.post('/oauth/device/authorize', async c => {
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
      // First login: set the admin password. Requires the server-local
      // setup code on top of the matching password inputs — the pending
      // grant alone proves nothing (anyone can create one), so without
      // this check a fresh remote deployment could be taken over.
      const expected = deps.getSetupCode?.() ?? null;
      const provided = normalizeSetupCode(form.get('setup_code') ?? '');
      ok =
        expected !== null &&
        provided !== null &&
        secretsEqual(provided, expected) &&
        confirm !== null &&
        confirm === password &&
        password.length >= 8 &&
        password.length <= 1024;
      if (ok) {
        try {
          adminAuth.set(hashPassword(password));
          deps.onSetupComplete?.();
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

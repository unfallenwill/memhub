/**
 * Device authorization grants (RFC 8628 subset, transport-free part).
 *
 * The OAuth device flow itself lives in the HTTP adapter; this module
 * holds the pieces that are pure infrastructure: the Crockford user-code
 * alphabet and normalization, the constant-time secret comparison and
 * the in-memory grant store with its capacity and expiry rules.
 *
 * Grants are lost on restart (in-flight logins retry cleanly).
 */

import { randomBytes, timingSafeEqual } from 'crypto';

/** Crockford base32 — no I/L/O/U to avoid transcription confusion. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Default per-address cap on pending grants. */
export const DEFAULT_MAX_PENDING_PER_IP = 10;

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
export function secretsEqual(a: string, b: string): boolean {
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
  /** Origin address of the code request (per-address grant cap). */
  readonly ip: string | null;
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
  /**
   * Pending grants a single address may hold at once. Keeps one host
   * from filling the global maxPending and blocking every legitimate
   * login (and first-run setup) worldwide.
   */
  readonly maxPendingPerIp?: number | undefined;
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
  create(label: string, ip: string | null = null): DeviceGrant | null {
    this.pruneExpired();
    if (this.grants.size >= this.options.maxPending) return null;
    if (ip !== null) {
      const perIp = this.options.maxPendingPerIp ?? DEFAULT_MAX_PENDING_PER_IP;
      let fromIp = 0;
      for (const grant of this.grants.values()) {
        if (grant.ip === ip) fromIp++;
      }
      if (fromIp >= perIp) return null;
    }
    const grant: DeviceGrant = {
      deviceCode: randomBytes(32).toString('hex'),
      userCode: generateUserCode(),
      label,
      ip,
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

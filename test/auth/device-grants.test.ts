import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_PENDING_PER_IP,
  DeviceGrantStore,
  secretsEqual,
  type DeviceGrant,
} from '../../src/auth/device-grants.js';

/**
 * A store with a controllable clock. The clock is shared with the
 * assertions so the expiry rules can be exercised without sleeps.
 */
function makeStore(
  options: {
    readonly ttlMs?: number;
    readonly maxPending?: number;
    readonly maxPendingPerIp?: number;
    readonly now?: () => number;
  } = {}
): { store: DeviceGrantStore; clock: { value: number } } {
  const clock = { value: 1_700_000_000_000 };
  const store = new DeviceGrantStore({
    ttlMs: options.ttlMs ?? 300_000,
    maxPending: options.maxPending ?? 1000,
    maxPendingPerIp: options.maxPendingPerIp,
    now: options.now ?? ((): number => clock.value),
  });
  return { store, clock };
}

/**
 * Create grants until one carries a Crockford character that has a
 * confusable ("0" -> "O", "1" -> "I"/"L"). Generated codes never
 * contain I/L/O themselves, so a typed confusable can only be
 * normalized back to a stored "0"/"1".
 */
function grantWithConfusable(store: DeviceGrantStore): DeviceGrant {
  for (let i = 0; i < 200; i++) {
    const grant = store.create('cli', '10.0.0.1');
    if (grant !== null && /[01]/.test(grant.userCode)) return grant;
  }
  throw new Error('no grant with a confusable character was generated');
}

describe('DeviceGrantStore', () => {
  describe('create', () => {
    it('creates a pending grant with the documented shape', () => {
      const { store, clock } = makeStore({ ttlMs: 300_000 });
      const grant = store.create('cli', '10.0.0.1');
      expect(grant).not.toBeNull();
      expect(grant!.label).toBe('cli');
      expect(grant!.ip).toBe('10.0.0.1');
      expect(grant!.status).toBe('pending');
      expect(grant!.attempts).toBe(0);
      expect(grant!.lastPollAt).toBe(0);
      expect(grant!.accessToken).toBeNull();
      expect(grant!.expiresAt).toBe(clock.value + 300_000);
      expect(grant!.deviceCode).toMatch(/^[0-9a-f]{64}$/);
      expect(grant!.userCode).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    });

    it('defaults the origin address to null (unknown source)', () => {
      const { store } = makeStore();
      const grant = store.create('cli');
      expect(grant).not.toBeNull();
      expect(grant!.ip).toBeNull();
    });

    it('mints a distinct device code and user code per grant', () => {
      const { store } = makeStore();
      const first = store.create('cli', '10.0.0.1');
      const second = store.create('cli', '10.0.0.1');
      expect(first!.deviceCode).not.toBe(second!.deviceCode);
      expect(first!.userCode).not.toBe(second!.userCode);
    });

    it('returns null once the global maxPending is exhausted', () => {
      const { store } = makeStore({ maxPending: 2, maxPendingPerIp: 10 });
      expect(store.create('cli', '10.0.0.1')).not.toBeNull();
      expect(store.create('cli', '10.0.0.2')).not.toBeNull();
      expect(store.create('cli', '10.0.0.3')).toBeNull();
    });

    it('returns null once the per-address cap is exhausted', () => {
      const { store } = makeStore({ maxPending: 100, maxPendingPerIp: 2 });
      expect(store.create('cli', '10.0.0.1')).not.toBeNull();
      expect(store.create('cli', '10.0.0.1')).not.toBeNull();
      expect(store.create('cli', '10.0.0.1')).toBeNull();
      // Another address is unaffected by the first address's usage.
      expect(store.create('cli', '10.0.0.2')).not.toBeNull();
    });

    it('does not apply the per-address cap to unknown origins', () => {
      const { store } = makeStore({ maxPending: 100, maxPendingPerIp: 1 });
      expect(store.create('cli', null)).not.toBeNull();
      expect(store.create('cli', null)).not.toBeNull();
      expect(store.create('cli', null)).not.toBeNull();
      // Unknown origins never count towards a known address either.
      expect(store.create('cli', '10.0.0.1')).not.toBeNull();
      expect(store.create('cli', '10.0.0.1')).toBeNull();
    });

    it('falls back to the default per-address cap', () => {
      const { store } = makeStore({ maxPending: 1000 });
      expect(DEFAULT_MAX_PENDING_PER_IP).toBe(10);
      for (let i = 0; i < DEFAULT_MAX_PENDING_PER_IP; i++) {
        expect(store.create('cli', '10.0.0.1')).not.toBeNull();
      }
      expect(store.create('cli', '10.0.0.1')).toBeNull();
    });

    it('counts grants of every status towards the per-address cap', () => {
      const { store } = makeStore({ maxPending: 100, maxPendingPerIp: 1 });
      const grant = store.create('cli', '10.0.0.1');
      grant!.status = 'approved';
      expect(store.create('cli', '10.0.0.1')).toBeNull();
    });

    it('frees capacity by pruning expired grants first', () => {
      const { store, clock } = makeStore({ ttlMs: 1000, maxPending: 1, maxPendingPerIp: 10 });
      expect(store.create('cli', '10.0.0.1')).not.toBeNull();
      clock.value += 1001;
      // The expired grant is dropped, so the new one fits.
      expect(store.create('cli', '10.0.0.1')).not.toBeNull();
    });

    it('falls back to the wall clock when no clock is injected', () => {
      const store = new DeviceGrantStore({ ttlMs: 1000, maxPending: 10 });
      const before = Date.now();
      const grant = store.create('cli', '10.0.0.1');
      expect(grant).not.toBeNull();
      expect(grant!.expiresAt).toBeGreaterThanOrEqual(before + 1000);
      expect(grant!.expiresAt).toBeLessThanOrEqual(Date.now() + 1000);
    });
  });

  describe('findByDeviceCode', () => {
    it('finds a live grant by its device code', () => {
      const { store } = makeStore();
      const grant = store.create('cli', '10.0.0.1');
      expect(store.findByDeviceCode(grant!.deviceCode)).toBe(grant);
    });

    it('returns null for an unknown device code', () => {
      const { store } = makeStore();
      expect(store.findByDeviceCode('0'.repeat(64))).toBeNull();
    });

    it('returns null for an expired grant', () => {
      const { store, clock } = makeStore({ ttlMs: 1000 });
      const grant = store.create('cli', '10.0.0.1');
      clock.value += 1001;
      expect(store.findByDeviceCode(grant!.deviceCode)).toBeNull();
    });
  });

  describe('findPendingByUserCode', () => {
    it('finds a pending grant by its user code', () => {
      const { store } = makeStore();
      const grant = store.create('cli', '10.0.0.1');
      expect(store.findPendingByUserCode(grant!.userCode)).toBe(grant);
    });

    it('accepts a lowercase user code', () => {
      const { store } = makeStore();
      const grant = store.create('cli', '10.0.0.1');
      expect(store.findPendingByUserCode(grant!.userCode.toLowerCase())).toBe(grant);
    });

    it('strips non-alphanumeric characters from the typed code', () => {
      const { store } = makeStore();
      const grant = store.create('cli', '10.0.0.1');
      const raw = grant!.userCode;
      expect(store.findPendingByUserCode(raw.replace('-', ' '))).toBe(grant);
      expect(store.findPendingByUserCode(raw.replace('-', '_'))).toBe(grant);
    });

    it('accepts the Crockford confusables I/L -> 1 and O -> 0', () => {
      const { store } = makeStore({ maxPending: 1000, maxPendingPerIp: 1000 });
      const grant = grantWithConfusable(store);
      const raw = grant.userCode;
      if (raw.includes('0')) {
        expect(store.findPendingByUserCode(raw.replace('0', 'O'))).toBe(grant);
      }
      if (raw.includes('1')) {
        expect(store.findPendingByUserCode(raw.replace('1', 'I'))).toBe(grant);
        expect(store.findPendingByUserCode(raw.replace('1', 'L'))).toBe(grant);
      }
    });

    it('returns null for a code of the wrong length', () => {
      const { store } = makeStore();
      const grant = store.create('cli', '10.0.0.1');
      const raw = grant!.userCode;
      expect(store.findPendingByUserCode('')).toBeNull();
      expect(store.findPendingByUserCode(raw.slice(0, 4))).toBeNull();
      expect(store.findPendingByUserCode(`${raw}0`)).toBeNull();
    });

    it('returns null for an unknown user code', () => {
      const { store } = makeStore();
      const grant = store.create('cli', '10.0.0.1');
      const normalized = grant!.userCode.replace('-', '');
      const other =
        ['00000000', '11111111', '22222222', '33333333'].find(code => code !== normalized) ??
        'ZZZZZZZZ';
      expect(store.findPendingByUserCode(other)).toBeNull();
    });

    it('does not match a grant that is no longer pending', () => {
      const { store } = makeStore();
      const grant = store.create('cli', '10.0.0.1');
      grant!.status = 'approved';
      expect(store.findPendingByUserCode(grant!.userCode)).toBeNull();
      grant!.status = 'denied';
      expect(store.findPendingByUserCode(grant!.userCode)).toBeNull();
    });

    it('does not match an expired grant', () => {
      const { store, clock } = makeStore({ ttlMs: 1000 });
      const grant = store.create('cli', '10.0.0.1');
      clock.value += 1001;
      expect(store.findPendingByUserCode(grant!.userCode)).toBeNull();
    });

    it('does not match a "U" code (U is not in the Crockford alphabet)', () => {
      const { store } = makeStore();
      store.create('cli', '10.0.0.1');
      expect(store.findPendingByUserCode('UUUUUUUU')).toBeNull();
    });

    it('does not match a stored code that cannot be normalized', () => {
      // White-box: the store only ever creates 8-char Crockford codes,
      // so a malformed stored code is only reachable by hand. The
      // lookup must treat it as "no match" instead of throwing.
      const { store } = makeStore();
      const grants = (store as unknown as { grants: Map<string, DeviceGrant> }).grants;
      grants.set('malformed', {
        deviceCode: 'malformed',
        userCode: 'ABC',
        label: 'cli',
        ip: null,
        expiresAt: Date.now() + 300_000,
        status: 'pending',
        attempts: 0,
        lastPollAt: 0,
        accessToken: null,
      });
      expect(store.findPendingByUserCode('12345678')).toBeNull();
    });
  });

  describe('delete', () => {
    it('removes the grant so it can no longer be found', () => {
      const { store } = makeStore();
      const grant = store.create('cli', '10.0.0.1');
      store.delete(grant!);
      expect(store.findByDeviceCode(grant!.deviceCode)).toBeNull();
      expect(store.findPendingByUserCode(grant!.userCode)).toBeNull();
    });

    it('frees the per-address capacity again', () => {
      const { store } = makeStore({ maxPending: 100, maxPendingPerIp: 1 });
      const grant = store.create('cli', '10.0.0.1');
      expect(store.create('cli', '10.0.0.1')).toBeNull();
      store.delete(grant!);
      expect(store.create('cli', '10.0.0.1')).not.toBeNull();
    });

    it('is a no-op for a grant that was never stored', () => {
      const { store } = makeStore();
      const grant = store.create('cli', '10.0.0.1');
      store.delete(grant!);
      expect(() => store.delete(grant!)).not.toThrow();
    });
  });

  describe('pruneExpired', () => {
    it('drops expired grants and keeps live ones', () => {
      const { store, clock } = makeStore({ ttlMs: 1000 });
      const expiring = store.create('cli', '10.0.0.1');
      clock.value += 500;
      const live = store.create('cli', '10.0.0.2');
      clock.value += 501;
      store.pruneExpired();
      expect(store.findByDeviceCode(expiring!.deviceCode)).toBeNull();
      expect(store.findByDeviceCode(live!.deviceCode)).toBe(live);
    });

    it('frees the global capacity', () => {
      const { store, clock } = makeStore({ ttlMs: 1000, maxPending: 1 });
      store.create('cli', '10.0.0.1');
      clock.value += 1001;
      store.pruneExpired();
      expect(store.create('cli', '10.0.0.1')).not.toBeNull();
    });
  });

  describe('secretsEqual', () => {
    it('matches identical secrets', () => {
      expect(secretsEqual('abc123', 'abc123')).toBe(true);
      expect(secretsEqual('', '')).toBe(true);
    });

    it('rejects different secrets of the same length', () => {
      expect(secretsEqual('abc123', 'abc124')).toBe(false);
    });

    it('rejects secrets of different lengths', () => {
      expect(secretsEqual('abc', 'abcd')).toBe(false);
    });
  });
});

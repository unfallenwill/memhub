import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createTokenAuth, tokensEqual } from '../../../src/http/middleware/token-auth.js';
import { ApiError } from '../../../src/http/errors.js';
import { tokenHash } from '../../../src/db/device-tokens.js';
import type { DeviceTokenRepository } from '../../../src/core/ports/repositories.js';
import type { DeviceTokenRecord } from '../../../src/core/domain/types.js';

const DAEMON_TOKEN = 'daemon-token';
const DEVICE_TOKEN = 'device-token';

/** A device token store the test controls. */
class FakeDeviceTokens implements DeviceTokenRepository {
  /** The ids whose last-used timestamp was written. */
  readonly touched: number[] = [];
  private readonly records = new Map<string, DeviceTokenRecord>();

  constructor(records: readonly DeviceTokenRecord[] = []) {
    for (const record of records) this.records.set(record.tokenHash, record);
  }

  create(hash: string, label: string): DeviceTokenRecord {
    const record: DeviceTokenRecord = {
      id: this.records.size + 1,
      tokenHash: hash,
      label,
      createdAt: '2024-01-01T00:00:00.000Z',
      lastUsedAt: null,
      revokedAt: null,
    };
    this.records.set(hash, record);
    return record;
  }

  findActiveByHash(hash: string): DeviceTokenRecord | null {
    const record = this.records.get(hash);
    if (record === undefined || record.revokedAt !== null) return null;
    return record;
  }

  list(): readonly DeviceTokenRecord[] {
    return [...this.records.values()];
  }

  touchLastUsed(id: number): void {
    this.touched.push(id);
  }

  revoke(id: number): boolean {
    for (const [hash, record] of this.records) {
      if (record.id === id) {
        this.records.set(hash, { ...record, revokedAt: '2024-01-01T00:00:00.000Z' });
        return true;
      }
    }
    return false;
  }

  revokeAll(): number {
    let count = 0;
    for (const [hash, record] of this.records) {
      if (record.revokedAt === null) {
        this.records.set(hash, { ...record, revokedAt: '2024-01-01T00:00:00.000Z' });
        count += 1;
      }
    }
    return count;
  }
}

/** A device token record with the given last-used timestamp. */
function deviceRecord(
  lastUsedAt: string | null,
  revokedAt: string | null = null
): DeviceTokenRecord {
  return {
    id: 1,
    tokenHash: tokenHash(DEVICE_TOKEN),
    label: 'cli',
    createdAt: '2024-01-01T00:00:00.000Z',
    lastUsedAt,
    revokedAt,
  };
}

/** A tiny app with the token middleware and one route behind it. */
function app(deviceTokens: DeviceTokenRepository): Hono {
  const instance = new Hono();
  instance.onError((error, c) =>
    error instanceof ApiError
      ? c.json({ error: error.code }, error.status as 401)
      : c.text('boom', 500)
  );
  instance.use('/api/*', createTokenAuth({ token: DAEMON_TOKEN, deviceTokens }));
  instance.get('/api/cards', c => c.json({ cards: [] }));
  return instance;
}

/** Perform a request with the given token header. */
function request(instance: Hono, token?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers['x-memhub-token'] = token;
  return instance.request('/api/cards', { headers });
}

describe('tokensEqual', () => {
  it('accepts the same token', () => {
    expect(tokensEqual('abc', 'abc')).toBe(true);
  });

  it('rejects a different token', () => {
    expect(tokensEqual('abc', 'abd')).toBe(false);
  });

  it('rejects a token of a different length without throwing', () => {
    expect(tokensEqual('abc', 'abcd')).toBe(false);
    expect(tokensEqual('', 'abc')).toBe(false);
  });
});

describe('createTokenAuth', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects a request without a token header', async () => {
    const response = await request(app(new FakeDeviceTokens()));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthorized' });
  });

  it('rejects a wrong token', async () => {
    const response = await request(app(new FakeDeviceTokens()), 'wrong-token');

    expect(response.status).toBe(401);
  });

  it('accepts the daemon token', async () => {
    const response = await request(app(new FakeDeviceTokens()), DAEMON_TOKEN);

    expect(response.status).toBe(200);
  });

  it('accepts an active device token', async () => {
    const deviceTokens = new FakeDeviceTokens([deviceRecord(null)]);
    const response = await request(app(deviceTokens), DEVICE_TOKEN);

    expect(response.status).toBe(200);
  });

  it('rejects a revoked device token', async () => {
    const deviceTokens = new FakeDeviceTokens([deviceRecord(null, '2024-01-01T00:00:00.000Z')]);
    const response = await request(app(deviceTokens), DEVICE_TOKEN);

    expect(response.status).toBe(401);
  });

  it('touches a device token that was never used', async () => {
    const deviceTokens = new FakeDeviceTokens([deviceRecord(null)]);

    await request(app(deviceTokens), DEVICE_TOKEN);

    expect(deviceTokens.touched).toEqual([1]);
  });

  it('touches a device token that was used more than a minute ago', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:02:00.000Z'));
    const deviceTokens = new FakeDeviceTokens([deviceRecord('2024-01-01T00:00:00.000Z')]);

    await request(app(deviceTokens), DEVICE_TOKEN);

    expect(deviceTokens.touched).toEqual([1]);
  });

  it('does not touch a device token that was just used', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:30.000Z'));
    const deviceTokens = new FakeDeviceTokens([deviceRecord('2024-01-01T00:00:00.000Z')]);

    await request(app(deviceTokens), DEVICE_TOKEN);

    expect(deviceTokens.touched).toEqual([]);
  });

  it('does not touch the daemon token', async () => {
    const deviceTokens = new FakeDeviceTokens();

    await request(app(deviceTokens), DAEMON_TOKEN);

    expect(deviceTokens.touched).toEqual([]);
  });
});

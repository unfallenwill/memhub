import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DeviceTokenStore, tokenHash } from '../../src/db/device-tokens.js';
import { createTestDb, type TestDb } from '../test-utils.js';

describe('device tokens', () => {
  let t: TestDb;
  let store: DeviceTokenStore;

  beforeEach(() => {
    t = createTestDb();
    store = new DeviceTokenStore(t.db);
  });

  afterEach(() => {
    t.close();
  });

  it('creates and finds a token by hash', () => {
    const hash = tokenHash('a'.repeat(64));
    const record = store.create(hash, 'user@host');
    expect(record.id).toBeGreaterThan(0);
    const found = store.findActiveByHash(hash);
    expect(found?.id).toBe(record.id);
    expect(found?.label).toBe('user@host');
    expect(found?.lastUsedAt).toBeNull();
  });

  it('does not find unknown or revoked tokens', () => {
    store.create(tokenHash('a'.repeat(64)), 'user@host');
    expect(store.findActiveByHash(tokenHash('b'.repeat(64)))).toBeNull();
    const record = store.create(tokenHash('c'.repeat(64)), 'other@host');
    store.revoke(record.id);
    expect(store.findActiveByHash(tokenHash('c'.repeat(64)))).toBeNull();
  });

  it('touchLastUsed sets the timestamp once', () => {
    const record = store.create(tokenHash('d'.repeat(64)), 'x@y');
    store.touchLastUsed(record.id);
    const found = store.findActiveByHash(tokenHash('d'.repeat(64)));
    expect(found?.lastUsedAt).not.toBeNull();
  });

  it('revoke returns false for unknown ids and double revokes', () => {
    expect(store.revoke(9999)).toBe(false);
    const record = store.create(tokenHash('e'.repeat(64)), 'x@y');
    expect(store.revoke(record.id)).toBe(true);
    expect(store.revoke(record.id)).toBe(false);
  });

  it('revokeAll counts only active tokens', () => {
    store.create(tokenHash('f'.repeat(64)), 'a@b');
    const second = store.create(tokenHash('0'.repeat(64)), 'c@d');
    store.revoke(second.id);
    store.create(tokenHash('1'.repeat(64)), 'e@f');
    expect(store.revokeAll()).toBe(2);
    expect(store.revokeAll()).toBe(0);
  });

  it('lists newest first without the hash being required for display', () => {
    const first = store.create(tokenHash('2'.repeat(64)), 'first');
    const second = store.create(tokenHash('3'.repeat(64)), 'second');
    const list = store.list();
    expect(list.map(d => d.label)).toEqual(['second', 'first']);
    expect(list.every(d => typeof d.id === 'number' && d.id > 0)).toBe(true);
    expect(second.id).toBeGreaterThan(first.id);
  });
});

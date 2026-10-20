/**
 * The db layer never reads the ambient time: every timestamp comes from
 * the injected clock. These tests pin that, and the consequences the
 * write path depends on (created_at === updated_at on creation, a
 * strictly later updated_at after an edit, and a last_used_at that the
 * throttle window of the caller can actually reason about).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { DeviceTokenStore, tokenHash } from '../../src/db/device-tokens.js';
import { cardInput, createTestDb, MutableClock, type TestDb } from '../test-utils.js';

/** The throttle window the HTTP layer uses for the last-used update. */
const TOUCH_INTERVAL_MS = 60_000;

describe('the injected clock', () => {
  let t: TestDb;
  const clock = new MutableClock('2024-05-01T10:00:00.000Z');

  afterEach(() => {
    t.close();
  });

  it('is the source of the card timestamps', () => {
    t = createTestDb({ clock });

    const created = t.cards.createCard(cardInput({ title: 'T', body: 'B' }));
    const card = t.cards.getCard(created.id);

    expect(card?.createdAt).toBe(clock.isoNow());
    expect(card?.updatedAt).toBe(clock.isoNow());
  });

  it('gives a new card the same created_at and updated_at', () => {
    t = createTestDb({ clock });

    const created = t.cards.createCard(cardInput({ title: 'T', body: 'B' }));
    const card = t.cards.getCard(created.id);

    expect(card?.createdAt).toBe(card?.updatedAt);
  });

  it('moves updated_at forward on an update, leaving created_at alone', () => {
    t = createTestDb({ clock });
    const created = t.cards.createCard(cardInput({ title: 'T', body: 'B' }));
    const before = t.cards.getCard(created.id);

    clock.advance(1_000);
    t.cards.updateCard(created.id, { title: 'changed' });
    const after = t.cards.getCard(created.id);

    expect(after?.createdAt).toBe(before?.createdAt);
    expect(after?.updatedAt).toBe(clock.isoNow());
    expect(after?.updatedAt).not.toBe(after?.createdAt);
    expect(Date.parse(after!.updatedAt)).toBeGreaterThan(Date.parse(after!.createdAt));
  });

  it('stamps the archive and the update of a card with the same moment', () => {
    t = createTestDb({ clock });
    const created = t.cards.createCard(cardInput({ title: 'T', body: 'B' }));

    clock.advance(5_000);
    const archived = t.cards.archiveCard(created.id);

    expect(archived?.archivedAt).toBe(clock.isoNow());
    expect(archived?.updatedAt).toBe(clock.isoNow());
  });

  it('stamps the events and the activity log', () => {
    t = createTestDb({ clock });

    t.cards.createCard(cardInput({ title: 'T', body: 'B' }));

    const event = t.events.listAll()[0];
    expect(event?.createdAt).toBe(clock.isoNow());

    const entry = t.activity.list(null, 10).entries[0];
    expect(entry?.ts).toBe(clock.isoNow());
  });

  it('stamps the device tokens', () => {
    t = createTestDb({ clock });
    const store = new DeviceTokenStore(t.db, clock);

    const record = store.create(tokenHash('a'.repeat(64)), 'user@host');
    expect(record.createdAt).toBe(clock.isoNow());
    expect(store.findActiveByHash(tokenHash('a'.repeat(64)))?.createdAt).toBe(clock.isoNow());
  });
});

describe('the device token last-used throttle window', () => {
  let t: TestDb;
  const clock = new MutableClock('2024-05-01T10:00:00.000Z');

  afterEach(() => {
    t.close();
  });

  /** The decision the HTTP middleware makes before touching the token. */
  function shouldTouch(lastUsedAt: string | null, nowMs: number): boolean {
    return lastUsedAt === null || nowMs - Date.parse(lastUsedAt) > TOUCH_INTERVAL_MS;
  }

  it('writes the clock time, so the window can be computed from it', () => {
    t = createTestDb({ clock });
    const store = new DeviceTokenStore(t.db, clock);
    const record = store.create(tokenHash('b'.repeat(64)), 'user@host');

    store.touchLastUsed(record.id);
    const found = store.findActiveByHash(tokenHash('b'.repeat(64)));

    expect(found?.lastUsedAt).toBe(clock.isoNow());
  });

  it('is not touched again inside the window and is touched after it', () => {
    t = createTestDb({ clock });
    const store = new DeviceTokenStore(t.db, clock);
    const record = store.create(tokenHash('c'.repeat(64)), 'user@host');

    // First use: the token was never used, so it is stamped.
    expect(shouldTouch(null, clock.now())).toBe(true);
    store.touchLastUsed(record.id);
    const first = store.findActiveByHash(tokenHash('c'.repeat(64)))?.lastUsedAt ?? null;
    expect(first).toBe(clock.isoNow());

    // Half a minute later the window is still open: no second write.
    clock.advance(30_000);
    const current = store.findActiveByHash(tokenHash('c'.repeat(64)))?.lastUsedAt ?? null;
    expect(shouldTouch(current, clock.now())).toBe(false);

    // Past the window the token is stamped again, with the new time.
    clock.advance(31_000);
    const stale = store.findActiveByHash(tokenHash('c'.repeat(64)))?.lastUsedAt ?? null;
    expect(shouldTouch(stale, clock.now())).toBe(true);
    store.touchLastUsed(record.id);
    expect(store.findActiveByHash(tokenHash('c'.repeat(64)))?.lastUsedAt).toBe(clock.isoNow());
  });
});

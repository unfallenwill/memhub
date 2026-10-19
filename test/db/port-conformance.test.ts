/**
 * The db adapters implement the ports of the pure core layer.
 *
 * The `implements` clause on every store is the compile-time check; the
 * typed assignments and the assertions below make the same contract
 * visible in the test report.
 *
 * The admin password store lives in src/auth/ (it is shared by the daemon
 * and the HTTP adapter) and is therefore not touched by the db layer. Its
 * conformance to the port is verified here instead.
 */

import { describe, expect, it } from 'vitest';
import { ActivityLog } from '../../src/db/activity.js';
import { CardStore } from '../../src/db/cards.js';
import { DeviceTokenStore } from '../../src/db/device-tokens.js';
import { EventStore } from '../../src/db/events.js';
import { KeywordSearch } from '../../src/db/keyword-search.js';
import { WorkerStateStore } from '../../src/db/worker-state.js';
import { AdminPasswordStore } from '../../src/db/admin-password.js';
import type {
  ActivityRepository,
  AdminPasswordRepository,
  CardRepository,
  DeviceTokenRepository,
  EventRepository,
  WorkerStateRepository,
} from '../../src/core/ports/repositories.js';
import type { KeywordSearchBackend } from '../../src/core/ports/search.js';
import { createTestDb } from '../test-utils.js';

describe('the db adapters satisfy the core ports', () => {
  it('CardStore satisfies CardRepository', () => {
    const t = createTestDb();
    try {
      const cards: CardRepository = new CardStore(t.db, {
        events: new EventStore(t.db),
        activity: new ActivityLog(t.db),
      });
      expect(typeof cards.createCard).toBe('function');
      expect(typeof cards.getCard).toBe('function');
      expect(typeof cards.listCards).toBe('function');
      expect(typeof cards.updateCard).toBe('function');
      expect(typeof cards.archiveCard).toBe('function');
      expect(typeof cards.invalidateCard).toBe('function');
      expect(typeof cards.recordAccess).toBe('function');
      expect(typeof cards.listActiveUnindexed).toBe('function');
      expect(typeof cards.listActiveIds).toBe('function');
      expect(typeof cards.resetActiveIndexedAt).toBe('function');
      expect(typeof cards.setIndexedAt).toBe('function');
      expect(typeof cards.stats).toBe('function');
      expect(cards.stats().total).toBe(0);
    } finally {
      t.close();
    }
  });

  it('EventStore satisfies EventRepository', () => {
    const t = createTestDb();
    try {
      const events: EventRepository = new EventStore(t.db);
      expect(typeof events.enqueue).toBe('function');
      expect(typeof events.stats).toBe('function');
      expect(typeof events.listBatchAfter).toBe('function');
      expect(typeof events.markProcessed).toBe('function');
      expect(typeof events.listAll).toBe('function');
      expect(events.stats().pendingEvents).toBe(0);
    } finally {
      t.close();
    }
  });

  it('ActivityLog satisfies ActivityRepository', () => {
    const t = createTestDb();
    try {
      const activity: ActivityRepository = new ActivityLog(t.db);
      expect(typeof activity.append).toBe('function');
      expect(typeof activity.list).toBe('function');
      expect(activity.list(null, 10).entries).toEqual([]);
    } finally {
      t.close();
    }
  });

  it('DeviceTokenStore satisfies DeviceTokenRepository', () => {
    const t = createTestDb();
    try {
      const tokens: DeviceTokenRepository = new DeviceTokenStore(t.db);
      expect(typeof tokens.create).toBe('function');
      expect(typeof tokens.findActiveByHash).toBe('function');
      expect(typeof tokens.list).toBe('function');
      expect(typeof tokens.touchLastUsed).toBe('function');
      expect(typeof tokens.revoke).toBe('function');
      expect(typeof tokens.revokeAll).toBe('function');
      expect(tokens.list()).toEqual([]);
    } finally {
      t.close();
    }
  });

  it('WorkerStateStore satisfies WorkerStateRepository', () => {
    const t = createTestDb();
    try {
      const state: WorkerStateRepository = new WorkerStateStore(t.db);
      expect(typeof state.get).toBe('function');
      expect(typeof state.set).toBe('function');
      expect(typeof state.getModel).toBe('function');
      expect(typeof state.setModel).toBe('function');
      expect(typeof state.getLastEventId).toBe('function');
      expect(typeof state.setLastEventId).toBe('function');
      expect(state.getLastEventId()).toBe(0);
    } finally {
      t.close();
    }
  });

  it('AdminPasswordStore satisfies AdminPasswordRepository', () => {
    const t = createTestDb();
    try {
      const admin: AdminPasswordRepository = new AdminPasswordStore(t.db);
      expect(typeof admin.get).toBe('function');
      expect(typeof admin.set).toBe('function');
      expect(typeof admin.clear).toBe('function');
      expect(admin.get()).toBeNull();
    } finally {
      t.close();
    }
  });

  it('KeywordSearch satisfies KeywordSearchBackend', () => {
    const t = createTestDb();
    try {
      const keyword: KeywordSearchBackend = new KeywordSearch(t.db, t.cards);
      expect(typeof keyword.search).toBe('function');
      expect(typeof keyword.searchUnindexed).toBe('function');
      expect(keyword.search('anything', 5)).toEqual([]);
    } finally {
      t.close();
    }
  });
});

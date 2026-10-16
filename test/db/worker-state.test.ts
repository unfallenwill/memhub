import { describe, expect, it } from 'vitest';
import { WORKER_STATE_KEYS, WorkerStateStore } from '../../src/db/worker-state.js';
import { createTestDb } from '../test-utils.js';

describe('WorkerStateStore', () => {
  it('returns null for unset keys', () => {
    const t = createTestDb();
    try {
      const state = new WorkerStateStore(t.db);
      expect(state.get('missing')).toBeNull();
      expect(state.getModel()).toBeNull();
    } finally {
      t.close();
    }
  });

  it('set upserts values', () => {
    const t = createTestDb();
    try {
      const state = new WorkerStateStore(t.db);
      state.set(WORKER_STATE_KEYS.lastEventId, '5');
      expect(state.get(WORKER_STATE_KEYS.lastEventId)).toBe('5');
      state.set(WORKER_STATE_KEYS.lastEventId, '6');
      expect(state.get(WORKER_STATE_KEYS.lastEventId)).toBe('6');

      state.set(WORKER_STATE_KEYS.model, 'all-MiniLM-L6-v2');
      expect(state.getModel()).toBe('all-MiniLM-L6-v2');
    } finally {
      t.close();
    }
  });
});

describe('WorkerStateStore offset', () => {
  it('defaults the offset to 0 and round-trips ids', () => {
    const t = createTestDb();
    try {
      const state = new WorkerStateStore(t.db);
      expect(state.getLastEventId()).toBe(0);
      state.setLastEventId(42);
      expect(state.getLastEventId()).toBe(42);
      state.setLastEventId(43);
      expect(state.getLastEventId()).toBe(43);
    } finally {
      t.close();
    }
  });

  it('setModel records the embedding model identity', () => {
    const t = createTestDb();
    try {
      const state = new WorkerStateStore(t.db);
      state.setModel('Xenova/all-MiniLM-L6-v2');
      expect(state.getModel()).toBe('Xenova/all-MiniLM-L6-v2');
    } finally {
      t.close();
    }
  });

  it('treats malformed offsets as 0', () => {
    const t = createTestDb();
    try {
      const state = new WorkerStateStore(t.db);
      state.set(WORKER_STATE_KEYS.lastEventId, 'not-a-number');
      expect(state.getLastEventId()).toBe(0);
      state.set(WORKER_STATE_KEYS.lastEventId, '-5');
      expect(state.getLastEventId()).toBe(0);
    } finally {
      t.close();
    }
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRuntimeContext } from '../../src/runtime/context.js';
import { JobTimers } from '../../src/worker/timers.js';
import { createDbContext } from '../../src/db/context.js';
import { createTestDb } from '../test-utils.js';

describe('JobTimers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('enqueues a compensation scan every hour and retention cleanup every day', () => {
    const t = createTestDb();
    const timers = new JobTimers(createDbContext(t.db));
    try {
      timers.start();
      expect(t.events.listAll()).toHaveLength(0); // nothing fires immediately

      vi.advanceTimersByTime(3_600_000);
      expect(t.events.listAll().map(e => e.type)).toEqual(['job.compensation_scan']);

      vi.advanceTimersByTime(86_400_000);
      const types = t.events.listAll().map(e => e.type);
      // 1 fire from the first advanceTimersByTime plus 24 more hours.
      expect(types.filter(type => type === 'job.compensation_scan')).toHaveLength(25);
      expect(types.filter(type => type === 'job.retention_cleanup')).toHaveLength(1);
      expect(t.events.listAll().every(e => e.processedAt === null)).toBe(true);
    } finally {
      timers.stop();
      t.close();
    }
  });

  it('supports custom intervals', () => {
    const t = createTestDb();
    const timers = new JobTimers(createDbContext(t.db), {
      compensationIntervalMs: 100,
      retentionIntervalMs: 250,
    });
    try {
      timers.start();
      vi.advanceTimersByTime(250);
      const types = t.events.listAll().map(e => e.type);
      expect(types.filter(type => type === 'job.compensation_scan')).toHaveLength(2);
      expect(types.filter(type => type === 'job.retention_cleanup')).toHaveLength(1);
    } finally {
      timers.stop();
      t.close();
    }
  });

  it('stop() halts the timers and start() is idempotent', () => {
    const t = createTestDb();
    const timers = new JobTimers(createDbContext(t.db), { compensationIntervalMs: 50 });
    try {
      timers.start();
      timers.start(); // no duplicate timers
      vi.advanceTimersByTime(50);
      expect(t.events.listAll()).toHaveLength(1);

      timers.stop();
      vi.advanceTimersByTime(500);
      expect(t.events.listAll()).toHaveLength(1);
    } finally {
      timers.stop();
      t.close();
    }
  });

  it('enqueues into the injected queue of the composition root', () => {
    const t = createTestDb();
    const context = createRuntimeContext({ db: t.db });
    const enqueue = vi.spyOn(context.events, 'enqueue');
    const timers = new JobTimers(context, {
      compensationIntervalMs: 100,
    });
    try {
      timers.start();
      vi.advanceTimersByTime(100);
      expect(enqueue).toHaveBeenCalledWith('job.compensation_scan', {});
      // The event really landed in the shared queue.
      expect(context.events.listAll().map(event => event.type)).toEqual(['job.compensation_scan']);
    } finally {
      timers.stop();
      t.close();
    }
  });
});

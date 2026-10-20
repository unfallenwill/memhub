import { describe, expect, it } from 'vitest';
import { systemClock } from '../../../src/core/ports/clock.js';

describe('systemClock', () => {
  it('now() returns milliseconds since the epoch', () => {
    const before = Date.now();
    const value = systemClock.now();
    const after = Date.now();

    expect(typeof value).toBe('number');
    expect(Number.isFinite(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(before);
    expect(value).toBeLessThanOrEqual(after);
  });

  it('isoNow() returns a parseable ISO-8601 timestamp', () => {
    const value = systemClock.isoNow();

    expect(typeof value).toBe('string');
    expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Number.isNaN(Date.parse(value))).toBe(false);
  });

  it('isoNow() tracks the same wall clock as now()', () => {
    const iso = systemClock.isoNow();
    const epoch = Date.parse(iso);
    expect(Math.abs(epoch - systemClock.now())).toBeLessThan(1000);
  });

  it('is monotonic enough for consecutive calls', () => {
    const first = systemClock.now();
    const second = systemClock.now();
    expect(second).toBeGreaterThanOrEqual(first);
  });
});

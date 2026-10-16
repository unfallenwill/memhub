import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../../src/http/rate-limiter.js';

describe('rate limiter', () => {
  it('allows hits up to the max inside the window', () => {
    const clock = 0;
    const limiter = new RateLimiter({ windowMs: 60_000, max: 3, now: () => clock });
    expect(limiter.hit('ip').allowed).toBe(true);
    expect(limiter.hit('ip').allowed).toBe(true);
    expect(limiter.hit('ip').allowed).toBe(true);
    const denied = limiter.hit('ip');
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterS).toBe(60);
  });

  it('tracks keys independently', () => {
    const limiter = new RateLimiter({ windowMs: 60_000, max: 1 });
    expect(limiter.hit('a').allowed).toBe(true);
    expect(limiter.hit('b').allowed).toBe(true);
    expect(limiter.hit('a').allowed).toBe(false);
    expect(limiter.hit('b').allowed).toBe(false);
  });

  it('slides: old hits leave the window', () => {
    let clock = 0;
    const limiter = new RateLimiter({ windowMs: 10_000, max: 1, now: () => clock });
    expect(limiter.hit('ip').allowed).toBe(true);
    expect(limiter.hit('ip').allowed).toBe(false);
    clock = 10_001;
    expect(limiter.hit('ip').allowed).toBe(true);
  });

  it('denied hits report a shrinking retry window', () => {
    let clock = 0;
    const limiter = new RateLimiter({ windowMs: 60_000, max: 1, now: () => clock });
    limiter.hit('ip');
    clock = 30_000;
    const denied = limiter.hit('ip');
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterS).toBe(30);
  });

  it('prune drops fully elapsed keys', () => {
    let clock = 0;
    const limiter = new RateLimiter({ windowMs: 1000, max: 5, now: () => clock });
    limiter.hit('gone');
    clock = 5000;
    limiter.prune();
    // Internal state is not exposed; a fresh hit must succeed again.
    expect(limiter.hit('gone').allowed).toBe(true);
  });
});

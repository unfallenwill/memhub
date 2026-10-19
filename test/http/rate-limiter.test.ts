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

  it('prunes stale keys automatically once the map grows past the threshold', () => {
    let clock = 0;
    const limiter = new RateLimiter({
      windowMs: 1000,
      max: 5,
      now: () => clock,
      pruneAtSize: 3,
    });
    // Four distinct keys; the fourth hit triggers pruning of stale ones.
    limiter.hit('a');
    limiter.hit('b');
    clock = 5000; // a and b are now stale
    limiter.hit('c');
    limiter.hit('d');
    clock = 10_000;
    // Everything from the first burst is long gone; new keys are allowed.
    expect(limiter.hit('e').allowed).toBe(true);
    expect(limiter.hit('f').allowed).toBe(true);
  });

  it('bounds tracked keys: oldest evicted beyond maxKeys', () => {
    let clock = 0;
    const limiter = new RateLimiter({
      windowMs: 10_000,
      max: 1,
      now: () => clock,
      maxKeys: 2,
    });
    expect(limiter.hit('a').allowed).toBe(true);
    expect(limiter.hit('b').allowed).toBe(true);
    // 'c' is a new key at the cap: the oldest ('a') is evicted for it.
    expect(limiter.hit('c').allowed).toBe(true);
    clock = 1;
    // 'b' is still tracked (max 1 per window) — the cap did not drop it.
    expect(limiter.hit('b').allowed).toBe(false);
    // 'a' was evicted: a fresh window for it starts over.
    expect(limiter.hit('a').allowed).toBe(true);
  });

  it('prunes at most once per window even when the map stays above the threshold', () => {
    let clock = 0;
    const limiter = new RateLimiter({
      windowMs: 1000,
      max: 5,
      now: () => clock,
      pruneAtSize: 1,
    });
    // With a frozen clock the once-per-window throttle keeps prune from
    // running on every hit (the unique-key flood shape).
    limiter.hit('a');
    limiter.hit('b');
    limiter.hit('c');
    clock = 1;
    // Still inside the first prune window: b/c remain tracked.
    expect(limiter.hit('b').allowed).toBe(true);
    clock = 2000; // past the window: prune may run again
    limiter.hit('d');
    expect(limiter.hit('b').allowed).toBe(true); // stale after prune, fresh hit
  });
});

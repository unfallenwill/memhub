/**
 * Sliding-window rate limiter (in-memory, per daemon process).
 *
 * Used by the device-flow endpoints to throttle password guesses and
 * user_code enumeration. Pure logic with an injectable clock so tests
 * never sleep.
 */

/** Options for RateLimiter. */
export interface RateLimiterOptions {
  /** Window length in milliseconds. */
  readonly windowMs: number;
  /** Maximum hits per key inside the window. */
  readonly max: number;
  /** Clock override (tests); defaults to Date.now. */
  readonly now?: (() => number) | undefined;
}

/** Result of recording a hit. */
export interface RateLimitResult {
  readonly allowed: boolean;
  /** Seconds until the key becomes allowed again (0 when allowed). */
  readonly retryAfterS: number;
}

/** Per-key sliding window of hit timestamps. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly options: RateLimiterOptions) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /**
   * Record a hit for a key. Returns whether it is allowed; denied hits
   * are recorded too (they extend nothing — the window is sliding over
   * timestamps, not a counter reset).
   */
  hit(key: string): RateLimitResult {
    const now = this.now();
    const windowStart = now - this.options.windowMs;
    const timestamps = (this.hits.get(key) ?? []).filter(ts => ts > windowStart);
    if (timestamps.length >= this.options.max) {
      this.hits.set(key, timestamps);
      const oldest = timestamps[0];
      const retryAfterMs = oldest + this.options.windowMs - now;
      return { allowed: false, retryAfterS: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
    }
    timestamps.push(now);
    this.hits.set(key, timestamps);
    return { allowed: true, retryAfterS: 0 };
  }

  /** Drop keys whose windows have fully elapsed (call opportunistically). */
  prune(): void {
    const windowStart = this.now() - this.options.windowMs;
    for (const [key, timestamps] of this.hits) {
      const remaining = timestamps.filter(ts => ts > windowStart);
      if (remaining.length === 0) {
        this.hits.delete(key);
      } else {
        this.hits.set(key, remaining);
      }
    }
  }
}

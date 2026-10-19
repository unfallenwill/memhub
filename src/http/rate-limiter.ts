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
  /**
   * Key count at which stale keys are pruned during a hit (at most once
   * per window, so a flood of unique keys cannot turn every hit into a
   * full scan).
   */
  readonly pruneAtSize?: number | undefined;
  /**
   * Hard cap on tracked keys. Beyond it the oldest key is evicted to make
   * room — memory stays bounded no matter how many unique addresses hit
   * the endpoint.
   */
  readonly maxKeys?: number | undefined;
}

/** Result of recording a hit. */
export interface RateLimitResult {
  readonly allowed: boolean;
  /** Seconds until the key becomes allowed again (0 when allowed). */
  readonly retryAfterS: number;
}

/** Default key count that triggers stale-key pruning during a hit. */
const DEFAULT_PRUNE_AT_SIZE = 1024;

/** Default hard cap on tracked keys. */
const DEFAULT_MAX_KEYS = 8192;

/** Per-key sliding window of hit timestamps. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private lastPruneAt: number | null = null;

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
    this.maintain(now, key);
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

  /**
   * Bounded-memory upkeep, run inside hit(): prune stale keys at most
   * once per window, and evict the oldest key when the hard cap is hit
   * by a new key (the flood shape).
   */
  private maintain(now: number, key: string): void {
    if (this.hits.size >= (this.options.pruneAtSize ?? DEFAULT_PRUNE_AT_SIZE)) {
      if (this.lastPruneAt === null || now - this.lastPruneAt >= this.options.windowMs) {
        this.prune();
        this.lastPruneAt = now;
      }
    }
    if (!this.hits.has(key) && this.hits.size >= (this.options.maxKeys ?? DEFAULT_MAX_KEYS)) {
      const oldest = this.hits.keys().next().value;
      if (oldest !== undefined) this.hits.delete(oldest);
    }
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

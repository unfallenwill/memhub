/**
 * Clock port.
 *
 * The domain layer never reads the ambient time directly; it asks a clock
 * so tests can freeze or shift time without patching globals.
 */

export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
  /** The current time as an ISO-8601 string. */
  isoNow(): string;
}

/** The default clock, backed by the host system time. */
export const systemClock: Clock = {
  now: () => Date.now(),
  isoNow: () => new Date().toISOString(),
};

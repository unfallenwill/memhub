/**
 * Transaction port.
 *
 * The write path must stay constant-fast: one transaction covers the card
 * insert plus its event and activity-log rows. The runner is a port so the
 * domain layer stays free of any database driver.
 */

export interface TransactionRunner {
  /** COMMIT on success, ROLLBACK + rethrow on error. Nesting is REJECTED. */
  transaction<T>(fn: () => T): T;
}

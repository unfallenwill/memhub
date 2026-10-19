/**
 * Admin password persistence.
 *
 * The single-row adapter behind the `admin_auth` table. The password
 * itself (hashing, verification) lives in the auth layer
 * (src/auth/admin-password.ts); this module only stores and reads the
 * hash, so the raw SQLite handle never leaks out of the db layer.
 */

import type { DatabaseSync } from 'node:sqlite';
import type { AdminAuthRecord } from '../core/domain/types.js';
import type { AdminPasswordRepository } from '../core/ports/repositories.js';

/** Single-row admin_auth persistence. */
export class AdminPasswordStore implements AdminPasswordRepository {
  constructor(private readonly db: DatabaseSync) {}

  /** The stored admin password, or null when not initialized. */
  get(): AdminAuthRecord | null {
    const row = this.db
      .prepare(
        'SELECT password_hash AS passwordHash, updated_at AS updatedAt FROM admin_auth WHERE id = 1'
      )
      .get() as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    return { passwordHash: row.passwordHash as string, updatedAt: row.updatedAt as string };
  }

  /** Set (or replace) the admin password hash. */
  set(passwordHash: string): void {
    this.db
      .prepare(
        `INSERT INTO admin_auth(id, password_hash, updated_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET password_hash = excluded.password_hash,
                                       updated_at = excluded.updated_at`
      )
      .run(passwordHash, new Date().toISOString());
  }

  /** Remove the admin password (back to uninitialized). */
  clear(): void {
    this.db.prepare('DELETE FROM admin_auth WHERE id = 1').run();
  }
}

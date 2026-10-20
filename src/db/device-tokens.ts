/**
 * Device token store (OAuth device-flow access tokens).
 *
 * Tokens issued by `memhub login` are 256-bit hex strings; only their
 * SHA-256 hashes are persisted, so a leaked database file does not leak
 * credentials. Hash lookups are exact-match on a UNIQUE column (no
 * timing side channel: the hash is one-way).
 */

import { createHash } from 'crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { DeviceTokenRecord } from '../core/domain/types.js';
import { systemClock, type Clock } from '../core/ports/clock.js';
import type { DeviceTokenRepository } from '../core/ports/repositories.js';

// The record type now lives in the pure domain layer; it is re-exported
// here so existing import points keep working.
export type { DeviceTokenRecord } from '../core/domain/types.js';

/** SHA-256 hex digest of a token, as stored in device_tokens. */
export function tokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf-8').digest('hex');
}

function toRecord(row: Record<string, unknown>): DeviceTokenRecord {
  return {
    id: row.id as number,
    tokenHash: row.tokenHash as string,
    label: row.label as string,
    createdAt: row.createdAt as string,
    lastUsedAt: (row.lastUsedAt as string | null) ?? null,
    revokedAt: (row.revokedAt as string | null) ?? null,
  };
}

/** Persistence for tokens minted by the device authorization flow. */
export class DeviceTokenStore implements DeviceTokenRepository {
  private readonly clock: Clock;

  constructor(
    private readonly db: DatabaseSync,
    clock: Clock = systemClock
  ) {
    this.clock = clock;
  }

  /** Insert a new device token; returns the stored record. */
  create(hash: string, label: string): DeviceTokenRecord {
    // One timestamp for the stored row and for the returned record, so
    // the two can never disagree.
    const now = this.clock.isoNow();
    const result = this.db
      .prepare('INSERT INTO device_tokens(token_hash, label, created_at) VALUES (?, ?, ?)')
      .run(hash, label, now);
    return {
      id: Number(result.lastInsertRowid),
      tokenHash: hash,
      label,
      createdAt: now,
      lastUsedAt: null,
      revokedAt: null,
    };
  }

  /** The active (non-revoked) token record for a hash, or null. */
  findActiveByHash(hash: string): DeviceTokenRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, token_hash AS tokenHash, label, created_at AS createdAt,
                last_used_at AS lastUsedAt, revoked_at AS revokedAt
         FROM device_tokens WHERE token_hash = ? AND revoked_at IS NULL`
      )
      .get(hash) as Record<string, unknown> | undefined;
    return row === undefined ? null : toRecord(row);
  }

  /** All tokens, newest first (for the web devices panel). */
  list(): readonly DeviceTokenRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, token_hash AS tokenHash, label, created_at AS createdAt,
                last_used_at AS lastUsedAt, revoked_at AS revokedAt
         FROM device_tokens ORDER BY id DESC`
      )
      .all() as unknown as Record<string, unknown>[];
    return rows.map(toRecord);
  }

  /** Update last_used_at for a token (throttled by the caller). */
  touchLastUsed(id: number): void {
    this.db
      .prepare('UPDATE device_tokens SET last_used_at = ? WHERE id = ?')
      .run(this.clock.isoNow(), id);
  }

  /** Revoke one token by id; returns false when it does not exist. */
  revoke(id: number): boolean {
    const result = this.db
      .prepare('UPDATE device_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
      .run(this.clock.isoNow(), id);
    return Number(result.changes) > 0;
  }

  /** Revoke every token; returns how many were still active. */
  revokeAll(): number {
    const result = this.db
      .prepare('UPDATE device_tokens SET revoked_at = ? WHERE revoked_at IS NULL')
      .run(this.clock.isoNow());
    return Number(result.changes);
  }
}

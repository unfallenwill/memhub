/**
 * Ordered schema migrations for the MemHub SQLite database.
 *
 * Each migration runs inside a transaction and is recorded in the
 * schema_migrations table; PRAGMA user_version is kept in sync so the
 * on-disk schema version is discoverable without the table as well.
 */

import type { DatabaseSync } from 'node:sqlite';

/** A single ordered migration. */
export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly statements: readonly string[];
}

/** All migrations, in ascending version order. */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial-schema',
    statements: [
      `CREATE TABLE cards(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        type TEXT NOT NULL,
        cues TEXT NOT NULL DEFAULT '[]',
        confidence REAL NOT NULL DEFAULT 0.5,
        writer TEXT,
        source TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        merged_into INTEGER,
        superseded_by INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        indexed_at TEXT,
        last_accessed_at TEXT,
        hit_count INTEGER NOT NULL DEFAULT 0,
        archived_at TEXT
      )`,
      `CREATE INDEX idx_cards_status ON cards(status)`,
      `CREATE INDEX idx_cards_title ON cards(title)`,
      `CREATE INDEX idx_cards_active_unindexed ON cards(id) WHERE status='active' AND indexed_at IS NULL`,
      `CREATE VIRTUAL TABLE cards_fts USING fts5(title, body, content='cards', content_rowid='id')`,
      `CREATE TRIGGER cards_fts_insert AFTER INSERT ON cards BEGIN
         INSERT INTO cards_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
       END`,
      `CREATE TRIGGER cards_fts_delete AFTER DELETE ON cards BEGIN
         INSERT INTO cards_fts(cards_fts, rowid, title, body)
         VALUES ('delete', old.id, old.title, old.body);
       END`,
      `CREATE TRIGGER cards_fts_update AFTER UPDATE OF title, body ON cards BEGIN
         INSERT INTO cards_fts(cards_fts, rowid, title, body)
         VALUES ('delete', old.id, old.title, old.body);
         INSERT INTO cards_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
       END`,
      `CREATE TABLE events(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        processed_at TEXT,
        error TEXT
      )`,
      `CREATE INDEX idx_events_unprocessed ON events(id) WHERE processed_at IS NULL`,
      `CREATE TABLE worker_state(
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`,
      `CREATE TABLE activity_log(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        card_id INTEGER,
        detail TEXT
      )`,
      `CREATE INDEX idx_activity_card ON activity_log(card_id)`,
    ],
  },
];

/** Read the current schema version (PRAGMA user_version). */
export function getSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  return row.user_version;
}

/** Apply all pending migrations. Idempotent: already-applied versions are skipped. */
export function migrateDatabase(db: DatabaseSync): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations(
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )`
  );
  const current = getSchemaVersion(db);
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const statement of migration.statements) {
        db.exec(statement);
      }
      db.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)').run(
        migration.version,
        migration.name,
        new Date().toISOString()
      );
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}

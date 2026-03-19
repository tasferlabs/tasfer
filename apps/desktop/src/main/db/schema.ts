/**
 * SQLite schema — initializes the local database.
 * Called once on app start.
 */

import type Database from "better-sqlite3";

export function initSchema(db: Database.Database) {
  db.exec(`
    -- Pages
    CREATE TABLE IF NOT EXISTS pages (
      id          TEXT PRIMARY KEY,
      title       TEXT,
      autoTitle   INTEGER NOT NULL DEFAULT 1,
      parentId    TEXT REFERENCES pages(id) ON DELETE SET NULL,
      "order"     INTEGER NOT NULL DEFAULT 0,
      task        INTEGER NOT NULL DEFAULT 0,
      color       TEXT,
      scheduledAt INTEGER,
      duration    INTEGER,
      allDay      INTEGER,
      recurrenceId TEXT,
      createdAt   TEXT NOT NULL DEFAULT (datetime('now')),
      updatedAt   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_pages_parentId ON pages(parentId);
    CREATE INDEX IF NOT EXISTS idx_pages_scheduledAt ON pages(scheduledAt);

    -- Snapshots
    CREATE TABLE IF NOT EXISTS snapshots (
      id        TEXT PRIMARY KEY,
      pageId    TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
      data      BLOB NOT NULL,
      size      INTEGER NOT NULL DEFAULT 0,
      clockCounter INTEGER,
      clockPeerId  TEXT,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_snapshots_pageId ON snapshots(pageId);

    -- CRDT operation log
    CREATE TABLE IF NOT EXISTS ops (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      pageId    TEXT NOT NULL,
      peerId    TEXT NOT NULL,
      counter   INTEGER NOT NULL,
      type      TEXT NOT NULL,
      data      TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ops_pageId ON ops(pageId);
    CREATE INDEX IF NOT EXISTS idx_ops_peer_counter ON ops(peerId, counter);

    -- Assets (content-addressed)
    CREATE TABLE IF NOT EXISTS assets (
      hash      TEXT PRIMARY KEY,
      fileName  TEXT NOT NULL,
      mimeType  TEXT NOT NULL,
      size      INTEGER NOT NULL,
      createdAt TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Identity
    CREATE TABLE IF NOT EXISTS config (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Known peers
    CREATE TABLE IF NOT EXISTS peers (
      publicKey TEXT PRIMARY KEY,
      name      TEXT,
      trusted   INTEGER NOT NULL DEFAULT 0,
      lastSeen  TEXT
    );

    -- Key-value storage (preferences, settings)
    CREATE TABLE IF NOT EXISTS storage (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

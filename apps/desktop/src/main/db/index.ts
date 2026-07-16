/**
 * Database connection — singleton better-sqlite3 instance.
 */

import { createRequire } from "module";
import type Database from "better-sqlite3";
import path from "path";
import { app } from "electron";
// Native modules must be loaded via createRequire to avoid bundling issues
const require = createRequire(import.meta.url);
const BetterSqlite3 = require("better-sqlite3");

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;

  const dbPath = path.join(app.getPath("userData"), "tasfer.db");
  db = new BetterSqlite3(dbPath);

  // WAL persists in the file; foreign_keys is per-connection and must be set each open.
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  return db;
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

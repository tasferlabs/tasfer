/**
 * SQLite database driver — better-sqlite3, the same engine the desktop app
 * runs in its main process.
 *
 * The Engine speaks raw SQL over {@link DbDriver}, so this is a thin adapter:
 * the only real work is normalising bound parameters, because better-sqlite3
 * rejects the JavaScript values a browser-side SQLite binding accepts.
 */

import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import type BetterSqlite3 from "better-sqlite3";
import type { DbDriver, DbRow, DbRunResult } from "@/platform/driver";
import { requireNative } from "./native";

/**
 * better-sqlite3 binds only numbers, strings, bigints, buffers and null.
 * The Engine's SQL is written against drivers that are laxer than that —
 * booleans and `undefined` reach it from optional columns — so normalise
 * here rather than auditing every call site.
 */
function bind(params: unknown[] | undefined): unknown[] {
  if (!params) return [];
  return params.map((value) => {
    if (value === undefined) return null;
    if (typeof value === "boolean") return value ? 1 : 0;
    if (value instanceof Uint8Array && !Buffer.isBuffer(value)) {
      return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    }
    return value;
  });
}

export class NodeDbDriver implements DbDriver {
  private db: BetterSqlite3.Database;
  /** Depth of nested transaction() calls — only the outermost one commits. */
  private txDepth = 0;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    const Database = requireNative<typeof BetterSqlite3>("better-sqlite3");
    this.db = new Database(dbPath);
    // WAL persists in the file; foreign_keys is per-connection and must be set
    // on every open.
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
  }

  async query<T extends DbRow = DbRow>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]> {
    return this.db.prepare(sql).all(...bind(params)) as T[];
  }

  async mutate(sql: string, params?: unknown[]): Promise<DbRunResult> {
    const result = this.db.prepare(sql).run(...bind(params));
    return {
      changes: result.changes,
      lastInsertRowId: Number(result.lastInsertRowid),
    };
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  /**
   * better-sqlite3's own `transaction()` wraps a synchronous function, and the
   * Engine's callbacks are async — so drive BEGIN/COMMIT by hand, the way the
   * desktop driver does over IPC. SQLite has no nested transactions, so an
   * inner call joins the outer one instead of opening a second.
   */
  async transaction<T>(fn: (db: DbDriver) => Promise<T>): Promise<T> {
    if (this.txDepth > 0) {
      this.txDepth++;
      try {
        return await fn(this);
      } finally {
        this.txDepth--;
      }
    }

    this.db.exec("BEGIN");
    this.txDepth = 1;
    try {
      const result = await fn(this);
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* already rolled back by SQLite */
      }
      throw e;
    } finally {
      this.txDepth = 0;
    }
  }

}

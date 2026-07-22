/**
 * Database handlers — thin IPC proxy for better-sqlite3.
 *
 * The renderer (Engine) sends raw SQL over IPC; we execute it
 * against the local SQLite database and return results.
 */

import { ipcMain } from "electron";
import { getDb } from "../db";

export function registerDbHandlers() {
  /** SELECT queries — returns array of row objects */
  ipcMain.handle(
    "db:query",
    (_, sql: string, params?: unknown[]) => {
      const db = getDb();
      const stmt = db.prepare(sql);
      return stmt.all(...(params ?? []));
    },
  );

  /** INSERT / UPDATE / DELETE — returns { changes, lastInsertRowId } */
  ipcMain.handle(
    "db:mutate",
    (_, sql: string, params?: unknown[]) => {
      const db = getDb();
      const stmt = db.prepare(sql);
      const result = stmt.run(...(params ?? []));
      return {
        changes: result.changes,
        lastInsertRowId: Number(result.lastInsertRowid),
      };
    },
  );

  /** Raw SQL execution (DDL, pragmas, multi-statement scripts) */
  ipcMain.handle("db:exec", (_, sql: string) => {
    const db = getDb();
    db.exec(sql);
  });
}

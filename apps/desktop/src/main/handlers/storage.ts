/**
 * Storage handlers — generic key-value store for preferences and settings.
 */

import { ipcMain } from "electron";
import { getDb } from "../db";

export function registerStorageHandlers() {
  ipcMain.handle("storage:get", (_, key: string) => {
    const db = getDb();
    const row = db
      .prepare("SELECT value FROM storage WHERE key = ?")
      .get(key) as { value: string } | undefined;

    if (!row) return null;
    try {
      return JSON.parse(row.value);
    } catch {
      return row.value;
    }
  });

  ipcMain.handle("storage:set", (_, key: string, value: unknown) => {
    const db = getDb();
    const serialized = JSON.stringify(value);
    db.prepare(
      `INSERT INTO storage (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = ?`,
    ).run(key, serialized, serialized);
  });

  ipcMain.handle("storage:remove", (_, key: string) => {
    const db = getDb();
    db.prepare("DELETE FROM storage WHERE key = ?").run(key);
  });
}

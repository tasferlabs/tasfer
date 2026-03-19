/**
 * Peers handlers — manage trusted peers.
 */

import { ipcMain } from "electron";
import { getDb } from "../db";

export function registerPeersHandlers() {
  ipcMain.handle("peers:list", () => {
    const db = getDb();
    return db
      .prepare("SELECT publicKey, name, trusted, lastSeen FROM peers")
      .all()
      .map((row: any) => ({
        publicKey: row.publicKey,
        name: row.name,
        trusted: !!row.trusted,
        lastSeen: row.lastSeen,
      }));
  });

  ipcMain.handle("peers:trust", (_, publicKey: string, name?: string) => {
    const db = getDb();
    db.prepare(
      `INSERT INTO peers (publicKey, name, trusted) VALUES (?, ?, 1)
       ON CONFLICT(publicKey) DO UPDATE SET trusted = 1, name = COALESCE(?, name)`,
    ).run(publicKey, name ?? null, name ?? null);

    const row = db
      .prepare("SELECT publicKey, name, trusted, lastSeen FROM peers WHERE publicKey = ?")
      .get(publicKey) as any;

    return {
      publicKey: row.publicKey,
      name: row.name,
      trusted: !!row.trusted,
      lastSeen: row.lastSeen,
    };
  });

  ipcMain.handle("peers:untrust", (_, publicKey: string) => {
    const db = getDb();
    db.prepare("UPDATE peers SET trusted = 0 WHERE publicKey = ?").run(publicKey);
  });

  ipcMain.handle("peers:remove", (_, publicKey: string) => {
    const db = getDb();
    db.prepare("DELETE FROM peers WHERE publicKey = ?").run(publicKey);
  });
}

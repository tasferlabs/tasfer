/**
 * Assets handlers — content-addressed file storage.
 * Files stored as assets/{hash}.{ext} in the user data directory.
 */

import { ipcMain, app, protocol, net } from "electron";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { getDb } from "../db";

function getAssetsDir(): string {
  const dir = path.join(app.getPath("userData"), "assets");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function extFromMime(mimeType: string): string {
  const map: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
  };
  return map[mimeType] || ".bin";
}

/** Register the cypher-asset:// protocol. Must be called before app.ready. */
export function registerAssetProtocol() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: "cypher-asset",
      privileges: { standard: true, secure: true, supportFetchAPI: true },
    },
  ]);
}

export function registerAssetsHandlers() {
  // Handle cypher-asset:// URLs to serve local asset files
  protocol.handle("cypher-asset", (request) => {
    const hash = new URL(request.url).hostname;
    const db = getDb();
    const row = db
      .prepare("SELECT mimeType FROM assets WHERE hash = ?")
      .get(hash) as { mimeType: string } | undefined;

    if (!row) {
      return new Response("Not found", { status: 404 });
    }

    const ext = extFromMime(row.mimeType);
    const filePath = path.join(getAssetsDir(), `${hash}${ext}`);
    return net.fetch(`file://${filePath}`);
  });

  ipcMain.handle(
    "assets:store",
    (_, buffer: ArrayBuffer, fileName: string, mimeType: string) => {
      const db = getDb();
      const buf = Buffer.from(buffer);

      // Content-addressed: hash the content
      const hash = crypto
        .createHash("sha256")
        .update(buf)
        .digest("hex")
        .slice(0, 32);
      const ext = extFromMime(mimeType);
      const filePath = path.join(getAssetsDir(), `${hash}${ext}`);

      // Write file if not already stored
      if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, buf);
      }

      // Upsert asset record
      db.prepare(
        `INSERT INTO assets (hash, fileName, mimeType, size) VALUES (?, ?, ?, ?)
         ON CONFLICT(hash) DO NOTHING`,
      ).run(hash, fileName, mimeType, buf.byteLength);

      return { hash, fileName, mimeType, size: buf.byteLength };
    },
  );

  ipcMain.handle("assets:delete", (_, hash: string) => {
    const db = getDb();
    const row = db
      .prepare("SELECT mimeType FROM assets WHERE hash = ?")
      .get(hash) as { mimeType: string } | undefined;

    if (row) {
      const ext = extFromMime(row.mimeType);
      const filePath = path.join(getAssetsDir(), `${hash}${ext}`);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      db.prepare("DELETE FROM assets WHERE hash = ?").run(hash);
    }
  });
}

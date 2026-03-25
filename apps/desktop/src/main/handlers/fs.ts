/**
 * Filesystem handlers — thin IPC proxy for node:fs.
 *
 * The renderer (Engine) sends file paths over IPC; we resolve them
 * relative to the user data directory and perform the operation.
 */

import { ipcMain, app } from "electron";
import fs from "fs";
import path from "path";

/** Resolve a relative path from the Engine to an absolute path in userData. */
function resolve(relativePath: string): string {
  return path.join(app.getPath("userData"), relativePath);
}

export function registerFsHandlers() {
  /** Read a file as bytes. Returns ArrayBuffer or null if not found. */
  ipcMain.handle("fs:read", (_, filePath: string) => {
    const abs = resolve(filePath);
    if (!fs.existsSync(abs)) return null;
    const buffer = fs.readFileSync(abs);
    return buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    );
  });

  /** Write bytes to a file, creating parent directories as needed. */
  ipcMain.handle("fs:write", (_, filePath: string, data: ArrayBuffer) => {
    const abs = resolve(filePath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, Buffer.from(data));
  });

  /** Delete a file. No-op if it doesn't exist. */
  ipcMain.handle("fs:delete", (_, filePath: string) => {
    const abs = resolve(filePath);
    if (fs.existsSync(abs)) fs.unlinkSync(abs);
  });

  /** List filenames in a directory. Returns [] if directory doesn't exist. */
  ipcMain.handle("fs:list", (_, dirPath: string) => {
    const abs = resolve(dirPath);
    if (!fs.existsSync(abs)) return [];
    return fs.readdirSync(abs);
  });

  /** Check if a path exists. */
  ipcMain.handle("fs:exists", (_, filePath: string) => {
    return fs.existsSync(resolve(filePath));
  });
}

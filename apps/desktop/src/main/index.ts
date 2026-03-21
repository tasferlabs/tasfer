/**
 * Electron main process — entry point.
 *
 * Creates the browser window, loads the renderer (web app),
 * and registers all IPC handlers.
 */

import { app, BrowserWindow } from "electron";
import path from "path";
import { getDb, closeDb } from "./db";
import { registerDbHandlers } from "./handlers/db";
import { registerFsHandlers } from "./handlers/fs";
import { registerCryptoHandlers } from "./handlers/crypto";
import { registerSyncHandlers } from "./handlers/sync";

// Dev mode: load from Vite dev server. Prod: load built files.
const isDev = !app.isPackaged;
const DEV_SERVER_URL = "http://localhost:4000";

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 400,
    minHeight: 300,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"), // electron-vite outputs to out/main and out/preload
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // needed for better-sqlite3 native module
    },
  });

  if (isDev) {
    win.loadURL(DEV_SERVER_URL);
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    // Production: load from the built web app
    // In production, load from the built web app (apps/web/dist)
    const rendererPath = path.join(__dirname, "../../../web/dist/index.html");
    win.loadFile(rendererPath);
  }

  return win;
}

// ── App lifecycle ──────────────────────────────────────────────────────────

app.whenReady().then(() => {
  // Initialize database
  getDb();

  // Register IPC handlers — thin proxies for db/fs/sync.
  // All business logic lives in the shared Engine (renderer side).
  registerDbHandlers();
  registerFsHandlers();
  registerCryptoHandlers();
  registerSyncHandlers();

  createWindow();

  app.on("activate", () => {
    // macOS: re-create window when dock icon clicked
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  // macOS: keep app running in dock
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("will-quit", () => {
  closeDb();
});

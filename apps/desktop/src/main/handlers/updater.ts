/**
 * Auto-updater handlers — checks GitHub Releases for new versions
 * and forwards progress events to the renderer via IPC.
 */

import { app, ipcMain, BrowserWindow } from "electron";
import { autoUpdater } from "electron-updater";

function sendToAllWindows(channel: string, ...args: unknown[]) {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, ...args);
  }
}

export function registerUpdaterHandlers() {
  // Let the renderer control when to download
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  // ── Forward autoUpdater events to renderer ─────────────────────────────

  autoUpdater.on("checking-for-update", () => {
    sendToAllWindows("updater:checking");
  });

  autoUpdater.on("update-available", (info) => {
    sendToAllWindows("updater:available", {
      version: info.version,
      releaseNotes: info.releaseNotes,
    });
  });

  autoUpdater.on("update-not-available", (info) => {
    sendToAllWindows("updater:not-available", {
      version: info.version,
    });
  });

  autoUpdater.on("download-progress", (progress) => {
    sendToAllWindows("updater:progress", {
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total,
    });
  });

  autoUpdater.on("update-downloaded", (info) => {
    sendToAllWindows("updater:downloaded", {
      version: info.version,
    });
  });

  autoUpdater.on("error", (err) => {
    sendToAllWindows("updater:error", {
      message: err.message,
    });
  });

  // ── IPC handlers — renderer-initiated actions ──────────────────────────

  ipcMain.handle("updater:check", async () => {
    return autoUpdater.checkForUpdates();
  });

  ipcMain.handle("updater:download", async () => {
    return autoUpdater.downloadUpdate();
  });

  ipcMain.handle("updater:install", () => {
    autoUpdater.quitAndInstall(false, true);
  });

  ipcMain.handle("updater:get-version", () => {
    return app.getVersion();
  });

  // ── Automatic checks ──────────────────────────────────────────────────

  // Check shortly after launch (give the window time to load)
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, 5_000);

  // Re-check every 4 hours
  setInterval(
    () => {
      autoUpdater.checkForUpdates().catch(() => {});
    },
    4 * 60 * 60 * 1_000,
  );
}

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

/**
 * Whether `electron-updater` can actually check for updates in this process.
 *
 * There's nothing to update against when the app isn't packaged (dev/unpacked
 * runs), and on Linux `electron-updater` only supports the AppImage target — it
 * keys off the `APPIMAGE` env var the AppImage runtime injects. Any other Linux
 * build (unpacked `out/`, a distro package, `.deb`) makes `checkForUpdates()`
 * throw "APPIMAGE env is not defined, current application is not an AppImage",
 * which then surfaces to the renderer as a spurious update error. Skip entirely
 * in those cases.
 */
function updatesSupported(): boolean {
  if (!app.isPackaged) return false;
  if (process.platform === "linux" && !process.env.APPIMAGE) return false;
  return true;
}

export function registerUpdaterHandlers() {
  const canUpdate = updatesSupported();

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
    if (!canUpdate) return null;
    return autoUpdater.checkForUpdates();
  });

  ipcMain.handle("updater:download", async () => {
    if (!canUpdate) return null;
    return autoUpdater.downloadUpdate();
  });

  ipcMain.handle("updater:install", () => {
    if (!canUpdate) return;
    autoUpdater.quitAndInstall(false, true);
  });

  ipcMain.handle("updater:get-version", () => {
    return app.getVersion();
  });

  // ── Automatic checks ──────────────────────────────────────────────────

  // Nothing to check against on unsupported builds — don't schedule the timers
  // (a bare checkForUpdates there just throws and spams updater:error).
  if (!canUpdate) return;

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

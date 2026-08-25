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

export interface UpdaterHandlerOptions {
  /**
   * Called right before the platform updater is handed an install. The host
   * uses it to drop the hide-to-tray interception on window close and to tear
   * the window down without waiting for the renderer, so the process is gone
   * before the installer checks whether the old app is still running.
   */
  onInstallRequested: () => void;
}

export function registerUpdaterHandlers({
  onInstallRequested,
}: UpdaterHandlerOptions) {
  const canUpdate = updatesSupported();

  // Fetch the update in the background as soon as a check finds one. The
  // renderer only surfaces status and offers the restart — a user who has to
  // ask for the download first mostly never gets one, since the sidebar banner
  // is the only place an update is announced.
  autoUpdater.autoDownload = true;
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

  // Returns a plain summary, never the `UpdateCheckResult` itself: that object
  // carries a promise and a cancellation token, which the IPC structured clone
  // cannot serialize. `supported: false` lets the renderer say why nothing
  // happened on a build the updater can't drive (dev run, non-AppImage Linux).
  ipcMain.handle("updater:check", async () => {
    if (!canUpdate) return { supported: false };
    const result = await autoUpdater.checkForUpdates();
    return {
      supported: true,
      available: result?.isUpdateAvailable ?? false,
      version: result?.updateInfo?.version ?? null,
    };
  });

  ipcMain.handle("updater:download", async () => {
    if (!canUpdate) return null;
    return autoUpdater.downloadUpdate();
  });

  // The installer replaces a bundle this process is still holding open, so it
  // only lands if we're gone promptly once it starts — see the deadline the
  // host's 'before-quit' handler works to. `onInstallRequested` is what lets it
  // recognise this quit and take the window down without waiting.
  ipcMain.handle("updater:install", () => {
    if (!canUpdate) return;
    onInstallRequested();
    autoUpdater.quitAndInstall(false, true);
  });

  // Injected from /version.json at build time. A packaged app's
  // `app.getVersion()` agrees with it (electron-builder stamps the same value),
  // but an unpackaged one has no version to read and reports Electron's instead.
  ipcMain.handle("updater:get-version", () => {
    return __APP_VERSION__;
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

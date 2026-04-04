/**
 * Electron main process — entry point.
 *
 * Creates the browser window, loads the renderer (web app),
 * and registers all IPC handlers.
 */

import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  ipcMain,
} from "electron";
import path from "path";
import { getDb, closeDb } from "./db";
import { registerDbHandlers } from "./handlers/db";
import { registerFsHandlers } from "./handlers/fs";
import { registerCryptoHandlers } from "./handlers/crypto";
import { registerUpdaterHandlers } from "./handlers/updater";

let tray: Tray | null = null;
let mainWindow: BrowserWindow | null = null;
let isQuitting = false;

// Dev mode: load from Vite dev server. Prod: load built files.
const isDev = !app.isPackaged;
const DEV_SERVER_URL = "http://localhost:4000";

// Icons are bundled inside the asar via the `files` config
const resourcesDir = isDev
  ? path.join(__dirname, "../../resources")
  : path.join(__dirname, "../../resources");

function createWindow() {
  const isMac = process.platform === "darwin";
  const isWindows = process.platform === "win32";

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 400,
    minHeight: 300,
    icon: path.join(resourcesDir, "icon.png"),
    // macOS: hidden inset keeps traffic lights with custom positioning
    // Windows/Linux: fully frameless — window controls rendered in the web app
    ...(isMac
      ? {
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: { x: 16, y: 18 },
        }
      : {
          frame: false,
        }),
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"), // electron-vite outputs to out/main and out/preload
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // needed for better-sqlite3 native module
    },
  });

  // Remove native menu bar on Windows/Linux — we render a custom one in the renderer.
  // macOS uses the system menu bar automatically.
  if (!isMac) {
    Menu.setApplicationMenu(null);
  }

  // Hide to tray instead of closing
  win.on("close", (e) => {
    if (!isQuitting) {
      e.preventDefault();
      win.hide();
      // On macOS, also hide from dock when window is hidden
      if (process.platform === "darwin") {
        app.dock?.hide();
      }
    }
  });

  if (isDev) {
    win.loadURL(DEV_SERVER_URL);
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    const webRoot = path.join(process.resourcesPath, "web");
    win.loadFile(path.join(webRoot, "index.html"));
  }

  mainWindow = win;
  return win;
}

function createTray() {
  let icon: Electron.NativeImage;
  if (process.platform === "darwin") {
    // macOS: use template image (system renders it as monochrome for light/dark menu bar)
    const iconPath = path.join(resourcesDir, "trayIconTemplate.png");
    icon = nativeImage.createFromPath(iconPath);
    icon.setTemplateImage(true);
  } else {
    // Windows/Linux: use the full app icon, resized for tray
    const iconPath = path.join(resourcesDir, "icon.png");
    icon = nativeImage.createFromPath(iconPath).resize({ width: 24, height: 24 });
  }

  tray = new Tray(icon);
  tray.setToolTip("Cypher");

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Show Cypher",
      click: () => {
        if (mainWindow) {
          if (process.platform === "darwin") {
            app.dock?.show();
          }
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);

  // Click on tray icon shows the window (primary action)
  tray.on("click", () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.focus();
      } else {
        if (process.platform === "darwin") {
          app.dock?.show();
        }
        mainWindow.show();
        mainWindow.focus();
      }
    }
  });
}

// ── Single instance lock ──────────────────────────────────────────────────
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (process.platform === "darwin") {
        app.dock?.show();
      }
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ── App lifecycle ──────────────────────────────────────────────────────────

app.whenReady().then(() => {
  // Set dock icon on macOS in dev only — production uses the .icns from the .app bundle
  if (process.platform === "darwin" && isDev) {
    const dockIcon = nativeImage.createFromPath(
      path.join(resourcesDir, "icon-1024.png"),
    );
    if (!dockIcon.isEmpty()) app.dock?.setIcon(dockIcon);
  }

  // Initialize database
  getDb();

  // Register IPC handlers — thin proxies for db/fs/sync.
  // All business logic lives in the shared Engine (renderer side).
  registerDbHandlers();
  registerFsHandlers();
  registerCryptoHandlers();
  registerUpdaterHandlers();

  // IPC handlers for custom menu bar actions (Windows/Linux renderer menu)
  ipcMain.handle("app:reload", () => mainWindow?.webContents.reload());
  ipcMain.handle("app:force-reload", () => mainWindow?.webContents.reloadIgnoringCache());
  ipcMain.handle("app:toggle-devtools", () => mainWindow?.webContents.toggleDevTools());
  ipcMain.handle("app:reset-zoom", () => mainWindow?.webContents.setZoomLevel(0));
  ipcMain.handle("app:zoom-in", () => {
    if (!mainWindow) return;
    const current = mainWindow.webContents.getZoomLevel();
    mainWindow.webContents.setZoomLevel(current + 0.5);
  });
  ipcMain.handle("app:zoom-out", () => {
    if (!mainWindow) return;
    const current = mainWindow.webContents.getZoomLevel();
    mainWindow.webContents.setZoomLevel(current - 0.5);
  });
  ipcMain.handle("app:toggle-fullscreen", () => {
    if (!mainWindow) return;
    mainWindow.setFullScreen(!mainWindow.isFullScreen());
  });
  ipcMain.handle("app:quit", () => {
    isQuitting = true;
    app.quit();
  });
  // Window control handlers (frameless window on Windows/Linux)
  ipcMain.handle("app:minimize", () => mainWindow?.minimize());
  ipcMain.handle("app:maximize", () => {
    if (!mainWindow) return;
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
  });
  ipcMain.handle("app:close", () => mainWindow?.close());

  createTray();
  createWindow();

  app.on("activate", () => {
    // macOS: re-create or show window when dock icon clicked
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    } else {
      createWindow();
    }
    app.dock?.show();
  });
});

// Keep app running — window close is intercepted by the 'close' handler above
app.on("window-all-closed", () => {
  // No-op: app stays alive in tray for background sync
});

app.on("before-quit", () => {
  isQuitting = true;
});

app.on("will-quit", () => {
  closeDb();
});

/**
 * Electron main process — entry point.
 *
 * Creates the browser window, loads the renderer (web app),
 * and registers all IPC handlers.
 */

import { app, BrowserWindow, Tray, Menu, nativeImage } from "electron";
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

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 400,
    minHeight: 300,
    icon: path.join(__dirname, "../../resources/icon.png"),
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"), // electron-vite outputs to out/main and out/preload
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // needed for better-sqlite3 native module
    },
  });

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
    // Production: load from the bundled web app (extraResources → resources/web/)
    const rendererPath = path.join(process.resourcesPath, "web/index.html");
    win.loadFile(rendererPath);
  }

  mainWindow = win;
  return win;
}

function createTray() {
  const iconPath = path.join(__dirname, "../../resources/trayIconTemplate.png");
  const icon = nativeImage.createFromPath(iconPath);
  // Mark as template so macOS renders it correctly in light/dark menu bar
  icon.setTemplateImage(true);

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

// ── App lifecycle ──────────────────────────────────────────────────────────

app.whenReady().then(() => {
  // Set dock icon on macOS (needed in dev since there's no .app bundle)
  if (process.platform === "darwin") {
    const dockIcon = nativeImage.createFromPath(
      path.join(__dirname, "../../resources/icon-1024.png"),
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

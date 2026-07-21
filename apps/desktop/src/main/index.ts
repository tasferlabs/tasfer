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
  type MenuItemConstructorOptions,
  nativeImage,
  ipcMain,
} from "electron";
import fs from "fs";
import path from "path";
import {
  FALLBACK_LOCALE,
  LOCALES,
  STRINGS,
  type Locale,
  type StringKey,
} from "./strings.generated";
import { getDb, closeDb } from "./db";
import { registerDbHandlers } from "./handlers/db";
import { registerFsHandlers } from "./handlers/fs";
import { registerCryptoHandlers } from "./handlers/crypto";
import { registerUpdaterHandlers } from "./handlers/updater";
import { registerPdfHandlers } from "./handlers/pdf";
import { registerContextMenuHandlers } from "./handlers/contextMenu";
import { registerThemeHandlers } from "./handlers/theme";

let tray: Tray | null = null;
let mainWindow: BrowserWindow | null = null;
let isQuitting = false;

// ── Tiling window manager detection (Linux) ────────────────────────────────
// i3, sway, bspwm and friends manage geometry themselves: minimizing an
// Electron window there usually hides it with no taskbar to bring it back, and
// "maximize" is meaningless. So we drop the minimize/maximize window controls
// (and the matching native window capabilities) when running under one. This is
// a best-effort read of the session environment — unknown means "not tiling",
// i.e. show every control. Computed once at launch and surfaced to the renderer
// (which draws the controls) over the `wm:tiling-sync` sync IPC via the preload.

/** WM names (as they appear in the desktop/session env vars) that tile. */
const TILING_WM_NAMES = [
  "i3",
  "sway",
  "bspwm",
  "dwm",
  "awesome",
  "xmonad",
  "herbstluftwm",
  "qtile",
  "spectrwm",
  "leftwm",
  "hyprland",
  "river",
  "wmii",
  "ratpoison",
  "stumpwm",
  "notion",
  "dk",
];

/**
 * The user runtime directory (`/run/user/<uid>`), where WM IPC sockets live.
 * Falls back to constructing it from the uid when `XDG_RUNTIME_DIR` is unset.
 */
function runtimeDir(): string | null {
  if (process.env.XDG_RUNTIME_DIR) return process.env.XDG_RUNTIME_DIR;
  const uid = process.getuid?.();
  return uid === undefined ? null : `/run/user/${uid}`;
}

/**
 * Probe the runtime directory for a WM's IPC socket. i3, Sway and Hyprland each
 * create one when they start, independent of the process environment — so this
 * detects them even when the app is launched straight from the WM (rofi, a
 * keybinding, a `.desktop` entry) and inherits none of their env vars.
 */
function tilingSocketPresent(): boolean {
  const dir = runtimeDir();
  if (!dir) return false;
  try {
    // i3 → <runtime>/i3/ipc-socket.*   Hyprland → <runtime>/hypr/
    if (fs.existsSync(path.join(dir, "i3"))) return true;
    if (fs.existsSync(path.join(dir, "hypr"))) return true;
    // Sway → <runtime>/sway-ipc.<uid>.<pid>.sock (flat file, not a subdir).
    return fs.readdirSync(dir).some((name) => name.startsWith("sway-ipc."));
  } catch {
    return false; // Unreadable runtime dir → fall through to other signals.
  }
}

function detectTilingWm(): boolean {
  if (process.platform !== "linux") return false;

  // WM-specific IPC sockets are the strongest signal when the app inherits the
  // WM's environment (e.g. launched from a terminal under the session).
  if (
    process.env.I3SOCK ||
    process.env.SWAYSOCK ||
    process.env.HYPRLAND_INSTANCE_SIGNATURE
  ) {
    return true;
  }

  // Match the session/desktop identifiers. These can be colon-separated lists
  // (e.g. XDG_CURRENT_DESKTOP), so split before comparing.
  const sources = [
    process.env.XDG_CURRENT_DESKTOP,
    process.env.XDG_SESSION_DESKTOP,
    process.env.DESKTOP_SESSION,
  ];
  if (
    sources.some((value) =>
      value
        ? value
            .toLowerCase()
            .split(":")
            .some((name) => TILING_WM_NAMES.includes(name.trim()))
        : false,
    )
  ) {
    return true;
  }

  // Last resort: the env can be empty when the WM is started from .xinitrc and
  // the app is launched without inheriting a login shell's exports. The IPC
  // socket on disk is authoritative in that case.
  return tilingSocketPresent();
}

const isTilingWm = detectTilingWm();

// ── Developer-tools setting ────────────────────────────────────────────────
// The "Show Developer Tools" app-menu toggle. Persisted in a tiny JSON file in
// userData (independent of the document DB) so it survives restarts, injected
// into the renderer at launch via the preload, and pushed on every toggle. The
// web app's `@/lib/devTools` flag is the single consumer.

const settingsPath = () => path.join(app.getPath("userData"), "settings.json");

interface Settings {
  devToolsEnabled?: boolean;
  locale?: string;
}

function readSettings(): Settings {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), "utf8")) ?? {};
  } catch {
    return {}; // No file yet / unreadable → defaults.
  }
}

/**
 * Merge `patch` into the persisted settings. Read-modify-write rather than a
 * whole-file replace: more than one setting lives here now, and writing just the
 * changed key would drop the others.
 */
function writeSettings(patch: Settings): void {
  try {
    fs.writeFileSync(
      settingsPath(),
      JSON.stringify({ ...readSettings(), ...patch }),
      "utf8",
    );
  } catch {
    // Best-effort; the in-session value still propagates to the renderer.
  }
}

let devToolsEnabled = false;

/** Apply a new value: persist, mirror onto the menu checkbox, push to renderer. */
function setDevToolsEnabled(value: boolean): void {
  devToolsEnabled = value;
  writeSettings({ devToolsEnabled: value });
  const item = Menu.getApplicationMenu()?.getMenuItemById("show-dev-tools");
  if (item) item.checked = value;
  mainWindow?.webContents.send("devtools:set", value);
}

// ── Interface language ─────────────────────────────────────────────────────
// The macOS application menu and the tray menu are drawn by the OS from labels
// this process supplies, so they cannot read i18next in the renderer. The web
// layer pushes the in-app language over `app:setLocale` on startup and on every
// change (see `setNativeLocale`); it is persisted so the menus are already right
// on the next launch, before the renderer has loaded. The OS language is only
// the initial guess, for a first run that has not been told otherwise.

let locale: Locale = FALLBACK_LOCALE;

/** Reduce a BCP-47 tag ("ar-EG") to a locale we ship, else the fallback. */
function normalizeLocale(tag: string | undefined): Locale {
  const base = (tag ?? "").toLowerCase().split("-")[0];
  return (LOCALES as readonly string[]).includes(base)
    ? (base as Locale)
    : FALLBACK_LOCALE;
}

/** Main-process translation lookup, mirroring i18next's per-key fallback. */
function t(key: StringKey): string {
  return STRINGS[locale][key] ?? STRINGS[FALLBACK_LOCALE][key];
}

/** Adopt a new language: persist, then redraw the OS-drawn menus. */
function setLocale(tag: string): void {
  const next = normalizeLocale(tag);
  if (next === locale) return;
  locale = next;
  writeSettings({ locale: next });
  if (process.platform === "darwin") {
    Menu.setApplicationMenu(buildMacMenu());
  }
  // Rebuild rather than relabel: Electron menu items are immutable once built.
  if (tray) tray.setContextMenu(buildTrayMenu());
}

// Dev mode: load from Vite dev server. Prod: load built files.
const isDev = !app.isPackaged;
// Defaults to HTTPS so a single `npm run dev:host` server (which serves the LAN
// over HTTPS with the mkcert cert; localhost is in its SAN and the mkcert CA is
// in the system trust store) drives desktop and mobile at once.
//
// Resolution order:
//   1. TASFER_DEV_URL          — one-off CLI override (`TASFER_DEV_URL=… npm run dev`)
//   2. MAIN_VITE_DEV_URL       — persistent per-machine value from apps/desktop/.env
//   3. https://localhost:4000  — default for a same-machine dev server
// Point these at the LAN host (e.g. https://192.168.xx.yy:4000) when the dev
// server runs on another device. electron-vite only exposes `MAIN_VITE_`-prefixed
// .env vars, and only via import.meta.env (never process.env); see .env.example.
const DEV_SERVER_URL =
  process.env.TASFER_DEV_URL ??
  import.meta.env.MAIN_VITE_DEV_URL ??
  "https://localhost:4000";

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

  // Under a tiling WM, minimize/maximize don't apply — drop the native window
  // capabilities to match the controls the renderer hides (see detectTilingWm).
  if (isTilingWm) {
    win.setMinimizable(false);
    win.setMaximizable(false);
  }

  // Remove native menu bar on Windows/Linux — we render a custom one in the
  // renderer (which reaches the "Show Developer Tools" toggle over IPC). macOS
  // uses the system menu bar, so install a template carrying the same toggle.
  if (isMac) {
    Menu.setApplicationMenu(buildMacMenu());
  } else {
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

/**
 * macOS application menu. Mostly standard roles (so Cmd+Q, Edit, Window, etc.
 * keep working) plus a checkbox "Show Developer Tools" item under View that
 * drives the in-app DevToolbar. Win/Linux don't use this — their renderer menu
 * carries the same item.
 */
function buildMacMenu(): Menu {
  const template: MenuItemConstructorOptions[] = [
    { role: "appMenu" },
    { role: "fileMenu" },
    { role: "editMenu" },
    {
      label: t("menu.view"),
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        {
          id: "show-dev-tools",
          // Distinct from Electron's built-in "Toggle Developer Tools" above —
          // this drives Tasfer's own in-app inspector panel.
          label: t("menu.showInspector"),
          type: "checkbox",
          checked: devToolsEnabled,
          click: () => setDevToolsEnabled(!devToolsEnabled),
        },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];
  return Menu.buildFromTemplate(template);
}

/** Tray context menu. Rebuilt on language change — menu items are immutable. */
function buildTrayMenu(): Menu {
  return Menu.buildFromTemplate([
    {
      label: t("menu.showTasfer"),
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
      label: t("menu.quit"),
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
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
  tray.setToolTip("Tasfer");

  tray.setContextMenu(buildTrayMenu());

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

  // Load the persisted "Show Developer Tools" setting before the window (and its
  // preload) reads it.
  const settings = readSettings();
  devToolsEnabled = settings.devToolsEnabled === true;

  // Language for the OS-drawn menus, before the renderer has had a chance to
  // push one. `app.getLocale()` is only the first-run guess.
  locale = normalizeLocale(settings.locale ?? app.getLocale());

  // Initialize database
  getDb();

  // Register IPC handlers — thin proxies for db/fs/sync.
  // All business logic lives in the shared Engine (renderer side).
  registerDbHandlers();
  registerFsHandlers();
  registerCryptoHandlers();
  registerUpdaterHandlers();
  registerPdfHandlers();
  registerContextMenuHandlers();
  registerThemeHandlers();

  // In-app language, pushed by the renderer on startup and on every change, so
  // the OS-drawn macOS menu and tray follow the in-app picker rather than the
  // desktop environment's language.
  ipcMain.handle("app:setLocale", (_event, tag: string) => setLocale(tag));

  // IPC handlers for custom menu bar actions (Windows/Linux renderer menu)
  ipcMain.handle("app:reload", () => mainWindow?.webContents.reload());
  ipcMain.handle("app:force-reload", () => mainWindow?.webContents.reloadIgnoringCache());
  ipcMain.handle("app:toggle-devtools", () => mainWindow?.webContents.toggleDevTools());
  // In-app DevToolbar enablement (distinct from Electron's inspector above).
  // Synchronous read for the preload's launch-time injection; toggle for the
  // renderer-drawn menu (Windows/Linux) and returns the new value.
  ipcMain.on("devtools:get-sync", (e) => {
    e.returnValue = devToolsEnabled;
  });
  // Static launch-time flag for the renderer's window controls: true under a
  // tiling WM, where minimize/maximize buttons are dropped.
  ipcMain.on("wm:tiling-sync", (e) => {
    e.returnValue = isTilingWm;
  });
  ipcMain.handle("devtools:toggle", () => {
    setDevToolsEnabled(!devToolsEnabled);
    return devToolsEnabled;
  });
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

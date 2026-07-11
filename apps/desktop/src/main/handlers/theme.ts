/**
 * Theme handler — keeps Electron's `nativeTheme` in sync with the app's in-app
 * light/dark choice.
 *
 * Native chrome (the editor context menu, the tray menu, the application menu)
 * is painted by the OS from `nativeTheme`. Left on its default `themeSource`,
 * `nativeTheme` follows the desktop environment's theme — e.g. a dark GTK theme
 * under i3 — and ignores the user's in-app selection, so switching the app to
 * light left the native context menu dark. The renderer pushes the user's theme
 * setting on mount and on every change (see web `useTheme`).
 *
 * The payload is the theme *source*, so "system" maps to Electron's own
 * `"system"` themeSource: native chrome tracks the OS and `prefers-color-scheme`
 * in the renderer stays live, so OS theme changes still propagate in system mode.
 */

import { ipcMain, nativeTheme } from "electron";

export function registerThemeHandlers() {
  ipcMain.handle(
    "editor:setColorScheme",
    (_event, source: "light" | "dark" | "system") => {
      nativeTheme.themeSource =
        source === "dark" ? "dark" : source === "light" ? "light" : "system";
    },
  );
}

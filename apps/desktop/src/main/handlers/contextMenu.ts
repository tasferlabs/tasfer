/**
 * Context menu handler — presents a native Electron menu for the editor.
 *
 * The renderer builds the same items it would render in its own popover and
 * sends a serializable model (see web `app/nativeContextMenu.ts`). We render it
 * with `Menu.popup()` and resolve the invoke() promise with the chosen item's
 * id, or null when the menu is dismissed without a selection.
 */

import { ipcMain, Menu, BrowserWindow, nativeImage } from "electron";
import type { MenuItemConstructorOptions } from "electron";

/** Serializable menu item mirrored from the web host. */
interface NativeMenuItem {
  id: string;
  label: string;
  icon?: string;
  /** Theme-colored PNG data URL rasterized by the web side. */
  iconPng?: string;
  enabled: boolean;
  checked?: boolean;
  children?: NativeMenuItem[];
}

/** Build a menu-sized native image from the web's 2x PNG data URL. */
function toMenuIcon(iconPng?: string) {
  if (!iconPng) return undefined;
  const image = nativeImage.createFromDataURL(iconPng);
  return image.isEmpty()
    ? undefined
    : image.resize({ width: 16, height: 16, quality: "best" });
}

interface ShowContextMenuRequest {
  model: NativeMenuItem[];
  anchor: { x: number; y: number; width: number; height: number };
}

export function registerContextMenuHandlers() {
  ipcMain.handle(
    "editor:showContextMenu",
    (event, req: ShowContextMenuRequest) => {
      return new Promise<string | null>((resolve) => {
        const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;

        // A click handler fires before the menu's close callback, so the first
        // settle wins: a picked id, otherwise null on dismissal.
        let settled = false;
        const settle = (id: string | null) => {
          if (!settled) {
            settled = true;
            resolve(id);
          }
        };

        const build = (
          items: NativeMenuItem[],
        ): MenuItemConstructorOptions[] =>
          items.map((item) => {
            if (item.children && item.children.length > 0) {
              return {
                label: item.label,
                icon: toMenuIcon(item.iconPng),
                submenu: build(item.children),
              };
            }
            return {
              label: item.label,
              icon: toMenuIcon(item.iconPng),
              enabled: item.enabled !== false,
              // A checkmark needs the checkbox role; unchecked rows stay normal
              // so they don't render an empty checkbox gutter.
              type: item.checked ? "checkbox" : "normal",
              checked: item.checked === true,
              click: () => settle(item.id),
            };
          });

        const menu = Menu.buildFromTemplate(build(req.model));
        // Anchor coordinates are viewport CSS pixels, which map 1:1 to Electron's
        // window-relative logical pixels (it handles DPI scaling internally).
        menu.popup({
          window: win,
          x: Math.round(req.anchor.x),
          y: Math.round(req.anchor.y),
          callback: () => settle(null),
        });
      });
    },
  );
}

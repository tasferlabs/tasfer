/**
 * Native context menu bridging.
 *
 * The editor's context menu is host-owned: the engine only dispatches
 * `OPEN_CONTEXT_MENU`, and the web host builds a `ContextMenuItem[]` and renders
 * a Radix popover. On native shells we instead present a platform-native menu
 * (iOS `UIMenu`/`UIEditMenuInteraction`, Android `PopupMenu`/`ActionMode`).
 *
 * `ContextMenuItem` carries a React `icon` node and a `() => void` action —
 * neither can cross the bridge. This module splits the items into:
 *   - a serializable `NativeMenuItem[]` model (the native side renders this), and
 *   - an `id -> action` map (the web side runs the chosen action).
 *
 * Item `id`s are the stable join key: they map to platform icons here and to the
 * action map at dispatch time, so keep them stable in `getContextMenuItems`.
 */

import {
  Bold,
  Clipboard,
  Code,
  Copy,
  Download,
  Grid3x3,
  ImageIcon,
  Italic,
  Link,
  type LucideIcon,
  Scissors,
  Sigma,
  Strikethrough,
  Type,
} from "lucide-react";
import { getBridge, type NativeMenuItem } from "@/platform/bridge";
import type { ContextMenuItem } from "../editor/ContextMenu";
import { getCachedMenuIcon, rasterizeMenuIcon } from "./menuIconRaster";

/**
 * Maps stable menu item ids to SF Symbol names. iOS renders these as native
 * template icons; unknown ids fall back to a text-only row.
 */
const ICON_BY_ID: Record<string, string> = {
  selectAll: "selection.pin.in.out",
  copy: "doc.on.doc",
  copyImage: "photo.on.rectangle",
  cut: "scissors",
  paste: "doc.on.clipboard",
  downloadImage: "arrow.down.circle",
  matrix: "square.grid.3x3",
  format: "textformat",
  "format-bold": "bold",
  "format-italic": "italic",
  "format-code": "chevron.left.forwardslash.chevron.right",
  "format-strikethrough": "strikethrough",
  "format-math": "function",
  "format-link": "link",
};

/**
 * The lucide component behind each menu id — the single source for icons that
 * the web menu shows. Hosts without a native icon catalog (Android, Electron)
 * get these rasterized to PNGs; iOS uses the SF Symbols above instead.
 */
const MENU_ICON_COMPONENTS: Record<string, LucideIcon> = {
  selectAll: Type,
  copy: Copy,
  copyImage: ImageIcon,
  cut: Scissors,
  paste: Clipboard,
  downloadImage: Download,
  matrix: Grid3x3,
  format: Type,
  "format-bold": Bold,
  "format-italic": Italic,
  "format-code": Code,
  "format-strikethrough": Strikethrough,
  "format-math": Sigma,
  "format-link": Link,
};

function iconNameFor(id: string): string | undefined {
  return ICON_BY_ID[id];
}

/** Foreground color for rasterized menu icons, matched to the active theme. */
function currentMenuIconColor(): string {
  const isDark =
    typeof document !== "undefined" &&
    document.documentElement.classList.contains("dark");
  return isDark ? "#f2f2f2" : "#1c1c1c";
}

/**
 * Rasterize every menu icon for the current theme into the cache, so the first
 * menu open already has icons. Call on editor mount and whenever the theme
 * flips. Cheap and idempotent — already-cached icons are skipped.
 */
export function prewarmMenuIcons(): void {
  if (typeof document === "undefined") return;
  const color = currentMenuIconColor();
  for (const [id, Icon] of Object.entries(MENU_ICON_COMPONENTS)) {
    void rasterizeMenuIcon(id, Icon, color);
  }
}

/**
 * Split host context-menu items into a serializable model and an action map.
 *
 * Disabled items are dropped (native menus don't benefit from greyed rows here,
 * and the web popover already hides them). Submenus recurse. Only leaf items with
 * an `action` are added to the map; the chosen id is looked up there at dispatch.
 */
export function toNativeMenu(items: ContextMenuItem[]): {
  model: NativeMenuItem[];
  actions: Map<string, () => void>;
} {
  const actions = new Map<string, () => void>();
  const color = currentMenuIconColor();

  const walk = (xs: ContextMenuItem[]): NativeMenuItem[] =>
    xs
      .filter((item) => !item.disabled)
      .map((item) => {
        if (item.action) actions.set(item.id, item.action);
        return {
          id: item.id,
          label: item.label,
          icon: iconNameFor(item.id),
          iconPng: getCachedMenuIcon(item.id, color),
          enabled: !item.disabled,
          checked: item.active,
          children: item.children ? walk(item.children) : undefined,
        };
      });

  return { model: walk(items), actions };
}

/** Anchor rectangle in viewport-relative CSS pixels. */
export interface NativeContextMenuAnchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NativeContextMenuRequest {
  model: NativeMenuItem[];
  anchor: NativeContextMenuAnchor;
}

/** Presents a native menu and resolves with the chosen item id, or null. */
export type NativeContextMenuPresenter = (
  req: NativeContextMenuRequest,
) => Promise<string | null>;

/** The Electron preload's generic IPC bridge, exposed as `window.tasfer`. */
interface DesktopIpcBridge {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
}

function getDesktopBridge(): DesktopIpcBridge | null {
  if (typeof window === "undefined") return null;
  const bridge = (window as unknown as { tasfer?: DesktopIpcBridge }).tasfer;
  return bridge && typeof bridge.invoke === "function" ? bridge : null;
}

/**
 * Resolve a native context-menu presenter for the current host, or null when
 * none exists (plain web → the caller renders its own popover).
 *
 * - iOS/Android expose `editor.showContextMenu` on the unified TasferBridge.
 * - Desktop (Electron) has no TasferBridge; it routes over the generic IPC
 *   bridge (`window.tasfer`) so we don't have to fake a full native bridge —
 *   which would otherwise flip `isNative()` and reroute clipboard/haptics/etc.
 */
export function getNativeContextMenuPresenter(): NativeContextMenuPresenter | null {
  const bridge = getBridge();
  if (bridge?.editor.showContextMenu) {
    const show = bridge.editor.showContextMenu.bind(bridge.editor);
    return (req) => show(req);
  }
  const desktop = getDesktopBridge();
  if (desktop) {
    return (req) =>
      desktop.invoke("editor:showContextMenu", req) as Promise<string | null>;
  }
  return null;
}

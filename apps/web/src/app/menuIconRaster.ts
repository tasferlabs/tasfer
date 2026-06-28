/**
 * Rasterizes lucide menu icons to theme-colored PNG data URLs.
 *
 * Native menus on Android (`PopupMenu`) and desktop (Electron `Menu`) can't
 * consume an SF Symbol name or raw SVG, so we render the same lucide icons the
 * web menu uses into PNGs — colored for the current theme — and ship the data
 * URL in the menu model. Results are cached per `id|color`; `toNativeMenu` reads
 * the cache synchronously, and `prewarmMenuIcons` fills it ahead of first use.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server.browser";
import type { LucideIcon } from "lucide-react";

/** Logical icon size in px; rasterized at 2x for crisp menu rendering. */
const ICON_SIZE = 18;
const SCALE = 2;

const cache = new Map<string, string>();
const inFlight = new Set<string>();

function keyOf(id: string, color: string): string {
  return `${id}|${color}`;
}

/** Cached PNG data URL for this icon/color, or undefined if not yet rasterized. */
export function getCachedMenuIcon(id: string, color: string): string | undefined {
  return cache.get(keyOf(id, color));
}

function rasterize(svg: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = ICON_SIZE * SCALE;
      canvas.height = ICON_SIZE * SCALE;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("no 2d context"));
        return;
      }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = () => reject(new Error("svg decode failed"));
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  });
}

/**
 * Rasterize one icon into the cache (idempotent, best-effort). Safe to call
 * repeatedly; concurrent calls for the same key coalesce.
 */
export async function rasterizeMenuIcon(
  id: string,
  Icon: LucideIcon,
  color: string,
): Promise<void> {
  const key = keyOf(id, color);
  if (cache.has(key) || inFlight.has(key)) return;
  inFlight.add(key);
  try {
    const svg = renderToStaticMarkup(
      createElement(Icon, { size: ICON_SIZE, color, strokeWidth: 2 }),
    );
    cache.set(key, await rasterize(svg));
  } catch {
    // Leave uncached — native falls back to a text-only row.
  } finally {
    inFlight.delete(key);
  }
}

/**
 * Styling helpers for full-screen surfaces (dev error page, Vite HMR overlay)
 * so they clear the platform's window chrome:
 *
 * - Mobile (iOS/Android): pad out of the notch / home indicator via safe-area
 *   insets. Android sets `--safe-area-inset-*`; iOS falls back to `env()`.
 * - Electron desktop: the top bar becomes a drag region, and on macOS it insets
 *   past the traffic-light buttons (which render above web content, so we can't
 *   sit text underneath them).
 */

import type { CSSProperties } from "react";
import { detectAdapterDetailed } from "@/platform";

// Geometry for the macOS traffic-light region lives in `:root` (styles.css) as
// the single source of truth shared with the app header and CSS modules:
// - inset: content starts clear of the lights. Always physical-left — the OS
//   draws the lights on the left in RTL too.
// - height: a bar this tall centers its (vertically centered) content on the
//   lights, which the shell renders at `y: 18` (apps/desktop/src/main/index.ts).
const MAC_TRAFFIC_LIGHT_INSET = "var(--mac-traffic-light-inset)";
const MAC_CHROME_BAR_HEIGHT = "var(--mac-chrome-bar-height)";

/** `-webkit-app-region` isn't in the DOM lib's CSSProperties; extend it. */
type DragStyle = CSSProperties & { WebkitAppRegion?: "drag" | "no-drag" };

/** Safe-area padding for a full-screen root — zero minimum gutter. */
export const FULLSCREEN_SAFE_AREA: CSSProperties = {
  paddingTop: "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))",
  paddingBottom: "var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))",
  paddingLeft: "var(--safe-area-inset-left, env(safe-area-inset-left, 0px))",
  paddingRight: "var(--safe-area-inset-right, env(safe-area-inset-right, 0px))",
};

/** Safe-area padding that keeps a comfortable 1.5rem minimum gutter per side. */
export const FULLSCREEN_SAFE_AREA_PADDED: CSSProperties = {
  paddingTop: "max(1.5rem, var(--safe-area-inset-top, env(safe-area-inset-top, 0px)))",
  paddingBottom:
    "max(1.5rem, var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)))",
  paddingLeft: "max(1.5rem, var(--safe-area-inset-left, env(safe-area-inset-left, 0px)))",
  paddingRight:
    "max(1.5rem, var(--safe-area-inset-right, env(safe-area-inset-right, 0px)))",
};

/**
 * Style for a full-screen overlay's top chrome bar so it clears desktop window
 * chrome. Off Electron this is empty (mobile/web bars sit at the true top).
 */
export function fullscreenChromeBarStyle(): DragStyle {
  const adapter = detectAdapterDetailed();
  if (adapter === "electron-macos") {
    return {
      WebkitAppRegion: "drag",
      paddingLeft: MAC_TRAFFIC_LIGHT_INSET,
      height: MAC_CHROME_BAR_HEIGHT,
    };
  }
  if (adapter.startsWith("electron")) {
    return { WebkitAppRegion: "drag" };
  }
  return {};
}

/** Interactive elements inside a drag region must opt out of window dragging. */
export const NO_DRAG: DragStyle = { WebkitAppRegion: "no-drag" };

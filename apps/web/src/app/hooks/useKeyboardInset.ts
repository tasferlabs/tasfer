import { isAndroid } from "@tasfer/editor/internal";
import { useEffect, useState } from "react";

/**
 * Live soft-keyboard inset in CSS px (0 when the keyboard is closed). Mirrors the
 * editor host's two-source precedence:
 *
 *   • Android: edge-to-edge WebViews keep their full viewport when the IME opens,
 *     so `visualViewport` does NOT shrink. MainActivity posts the real inset as a
 *     `keyboard-height-changed` message (the same signal the editor consumes).
 *     Once a native source reports, it wins.
 *   • iOS / mobile web: the WebView keeps its full height (iOS runs Capacitor
 *     Keyboard `resize: "none"` — see capacitor.config.js), so `visualViewport`
 *     shrinks for the keyboard and we derive the inset from it.
 *
 * Intended for `position: fixed` mobile overlays (the base Drawer, the calendar
 * bottom sheet, the editor toolbar dock) whose bottom edge would otherwise hide
 * behind the keyboard — they pad/offset by this inset to sit above it. Reading the
 * keyboard is a host/platform concern; the editor engine knows nothing about it.
 */
export default function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    const vv = window.visualViewport;
    // Once a native source reports the IME inset, ignore the visualViewport
    // fallback — matching the editor host's precedence.
    let nativeReported = false;

    // Edge-to-edge Android Chrome's viewport shrink is short by the gesture-nav
    // bar, whose height is only visible to CSS while the keyboard is closed —
    // capture it then and fold it into the open inset. Mirrors the editor
    // host's web keyboard sync (see MountedEditor), which documents the
    // measurements behind this.
    const probe = document.createElement("div");
    probe.style.cssText =
      "position:fixed;top:0;left:0;visibility:hidden;pointer-events:none;" +
      "padding-bottom:var(--safe-area-inset-bottom,env(safe-area-inset-bottom,0px));";
    document.body.appendChild(probe);
    let closedSafeAreaBottom = 0;

    const syncFromViewport = () => {
      if (nativeReported || !vv) return;
      const next = window.innerHeight - vv.height - vv.offsetTop;
      if (next <= 0) {
        closedSafeAreaBottom =
          parseFloat(getComputedStyle(probe).paddingBottom) || 0;
        setInset(0);
        return;
      }
      setInset(Math.round(next + (isAndroid() ? closedSafeAreaBottom : 0)));
    };

    // Android IME inset posted by MainActivity: { type, height (dp ≈ CSS px),
    // isOpen }. Validated inline to keep the hook self-contained.
    const onNativeKeyboard = (event: MessageEvent) => {
      const data = event.data as {
        type?: unknown;
        height?: unknown;
        isOpen?: unknown;
      } | null;
      if (
        event.source !== window ||
        !data ||
        data.type !== "keyboard-height-changed" ||
        typeof data.height !== "number" ||
        !Number.isFinite(data.height) ||
        typeof data.isOpen !== "boolean"
      ) {
        return;
      }
      nativeReported = true;
      setInset(data.isOpen ? Math.max(0, data.height) : 0);
    };

    syncFromViewport();
    vv?.addEventListener("resize", syncFromViewport);
    vv?.addEventListener("scroll", syncFromViewport);
    window.addEventListener("message", onNativeKeyboard);
    return () => {
      vv?.removeEventListener("resize", syncFromViewport);
      vv?.removeEventListener("scroll", syncFromViewport);
      window.removeEventListener("message", onNativeKeyboard);
      probe.remove();
    };
  }, []);

  return inset;
}

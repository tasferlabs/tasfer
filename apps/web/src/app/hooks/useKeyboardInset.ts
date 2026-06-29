import { useEffect, useState } from "react";

/**
 * Live soft-keyboard inset in CSS px (0 when the keyboard is closed). Mirrors the
 * editor host's two-source precedence:
 *
 *   • Android: edge-to-edge WebViews keep their full viewport when the IME opens,
 *     so `visualViewport` does NOT shrink. MainActivity posts the real inset as a
 *     `keyboard-height-changed` message (the same signal the editor consumes).
 *     Once a native source reports, it wins.
 *   • iOS / mobile web: `visualViewport` shrinks for the keyboard; derive the
 *     inset from it. (iOS native resizes the WebView, so the inset stays ~0 there
 *     and no adjustment is needed.)
 *
 * Intended for full-screen mobile overlays (e.g. the base Drawer) that are
 * `position: fixed` and therefore do NOT follow the visual viewport on iOS — so
 * their bottom edge would otherwise hide behind the keyboard. Reading the
 * keyboard is a host/platform concern; the editor engine knows nothing about it.
 */
export default function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    const vv = window.visualViewport;
    // Once a native source reports the IME inset, ignore the visualViewport
    // fallback — matching the editor host's precedence.
    let nativeReported = false;

    const syncFromViewport = () => {
      if (nativeReported || !vv) return;
      const next = window.innerHeight - vv.height - vv.offsetTop;
      setInset(next > 0 ? next : 0);
    };

    // Android IME inset posted by MainActivity: { type, height (dp ≈ CSS px),
    // isOpen }. Validated inline to keep the hook self-contained.
    const onNativeKeyboard = (event: MessageEvent) => {
      const data = event.data as
        | { type?: unknown; height?: unknown; isOpen?: unknown }
        | null;
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
    };
  }, []);

  return inset;
}

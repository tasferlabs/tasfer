import { useEffect, useState } from "react";

export interface SafeAreaInsets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

const ZERO: SafeAreaInsets = { top: 0, right: 0, bottom: 0, left: 0 };

/**
 * Read the platform safe-area insets (notch, status bar, home indicator) as
 * plain pixel values. Android exposes them as `--safe-area-inset-*`, iOS as
 * `env(safe-area-inset-*)`; a hidden probe styled with both resolves whichever
 * the platform provides. Recomputed on resize/orientation changes.
 *
 * Reading these is a host/platform concern — the editor engine knows nothing
 * about safe areas, so callers fold the result into host layout (e.g. the
 * editor's `padding`).
 */
export function useSafeAreaInsets(): SafeAreaInsets {
  const [insets, setInsets] = useState<SafeAreaInsets>(ZERO);

  useEffect(() => {
    const probe = document.createElement("div");
    probe.style.cssText =
      "position:fixed;top:0;left:0;visibility:hidden;pointer-events:none;" +
      "padding-top:var(--safe-area-inset-top,env(safe-area-inset-top,0px));" +
      "padding-right:var(--safe-area-inset-right,env(safe-area-inset-right,0px));" +
      "padding-bottom:var(--safe-area-inset-bottom,env(safe-area-inset-bottom,0px));" +
      "padding-left:var(--safe-area-inset-left,env(safe-area-inset-left,0px));";
    document.body.appendChild(probe);

    const read = () => {
      const cs = getComputedStyle(probe);
      const next: SafeAreaInsets = {
        top: parseFloat(cs.paddingTop) || 0,
        right: parseFloat(cs.paddingRight) || 0,
        bottom: parseFloat(cs.paddingBottom) || 0,
        left: parseFloat(cs.paddingLeft) || 0,
      };
      setInsets((prev) =>
        prev.top === next.top &&
        prev.right === next.right &&
        prev.bottom === next.bottom &&
        prev.left === next.left
          ? prev
          : next,
      );
    };

    read();
    window.addEventListener("resize", read);
    window.addEventListener("orientationchange", read);
    return () => {
      window.removeEventListener("resize", read);
      window.removeEventListener("orientationchange", read);
      probe.remove();
    };
  }, []);

  return insets;
}

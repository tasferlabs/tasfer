import type { ReactNode } from "react";

import useKeyboardInset from "../hooks/useKeyboardInset";

interface BottomToolDockProps {
  children: ReactNode;
}

/**
 * Shared positioning container for compact tools shown at the bottom of the app
 * (e.g. the dev-tools pill and the word-count tag). Add new tools as children
 * and they will append to the same row.
 *
 * The dock is `position: fixed`, so on mobile it would otherwise be hidden
 * behind the soft keyboard (the Android IME does not shrink the visual
 * viewport), behind the keyboard formatting toolbar that rides above it, or
 * under the bottom safe-area inset (gesture bar).
 *
 * These obstacles do NOT add up: when the keyboard is open it already spans the
 * bottom safe-area region (the gesture bar sits behind it), so the offset is the
 * larger of the two stacks — keyboard inset + toolbar height, or the safe-area
 * inset — plus a base gap. The toolbar publishes `--keyboard-toolbar-height`
 * only while mounted (0px otherwise) and the keyboard inset is 0 when the
 * keyboard is closed (or on platforms whose WebView resizes for the IME), so
 * this collapses to the plain safe-area placement when nothing overlaps.
 */
export function BottomToolDock({ children }: BottomToolDockProps) {
  const keyboardInset = useKeyboardInset();
  return (
    <div
      className="fixed end-3 z-40 flex items-center gap-2"
      style={{
        bottom: `calc(0.75rem + max(${keyboardInset}px + var(--keyboard-toolbar-height, 0px), var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))))`,
      }}
    >
      {children}
    </div>
  );
}

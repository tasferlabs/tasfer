import {
  useCallback,
  useRef,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";

import useKeyboardInset from "../hooks/useKeyboardInset";

interface BottomToolDockProps {
  children: ReactNode;
}

// Controls the dock activates on press.
const ACTIVATABLE = "button, [role='button'], a[href]";

// Fields that must keep their native press behaviour (focus, caret placement).
// No tag holds one today; a future one would still work.
const TEXT_FIELD = "input, textarea, select, [contenteditable='true']";

// Escape hatch for a full surface rendered from inside the dock — a panel or
// sheet that a tag opens. Those are ordinary UI with scrollers and inputs, not
// a tag riding the keyboard, so they keep click semantics.
const PASSTHROUGH = "[data-dock-passthrough]";

// A real click may still follow the press we already acted on. Swallow it
// within this window so a tag never fires twice for one tap.
const CLICK_GRACE_MS = 1200;

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
 *
 * Riding the keyboard costs the tags their taps: pressing one takes focus off
 * the editor's hidden input, the keyboard retracts, and the dock drops by the
 * keyboard's height — but the browser hit-tests the synthesized click at the
 * finger's original coordinates, where the canvas now sits, so `click` never
 * reaches the tag (the engine's touchEnd handler documents the same race).
 * The dock therefore settles a touch on pointerdown for every tag it holds:
 * it prevents the default (no focus change, so nothing moves before the intent
 * is recorded), activates the control, and swallows the click that may follow.
 * The press is absorbed even when it hits no control, so a tap on a tag's
 * padding is simply inert instead of costing the writer their keyboard. New
 * tags get both for free; a surface a tag opens opts out with
 * `data-dock-passthrough`.
 */
export function BottomToolDock({ children }: BottomToolDockProps) {
  const keyboardInset = useKeyboardInset();
  const activatedAt = useRef(0);

  const handlePointerDown = useCallback((e: PointerEvent<HTMLDivElement>) => {
    // Mouse keeps conventional click-on-release semantics; only touch/pen taps
    // race the keyboard.
    if (e.pointerType === "mouse" || !e.isPrimary || e.button !== 0) return;
    const target = e.target as Element | null;
    if (!target || target.closest(PASSTHROUGH) || target.closest(TEXT_FIELD)) {
      return;
    }
    // Swallow the press wherever it lands in the dock, control or not: a tap on
    // a tag's own chrome — its padding, the gap between two tags — would
    // otherwise take focus off the editor's hidden input and drop the keyboard
    // while doing nothing.
    e.preventDefault();
    const control = target.closest<HTMLElement>(ACTIVATABLE);
    if (
      !control ||
      (control as HTMLButtonElement).disabled ||
      control.getAttribute("aria-disabled") === "true"
    ) {
      return;
    }
    activatedAt.current = performance.now();
    control.click();
  }, []);

  const handleClick = useCallback((e: MouseEvent<HTMLDivElement>) => {
    // `detail === 0` is our own synthesized click (and keyboard activation);
    // anything else this soon after a press we already handled is the tap's
    // trailing click.
    if (e.detail === 0) return;
    if (performance.now() - activatedAt.current > CLICK_GRACE_MS) return;
    activatedAt.current = 0;
    e.preventDefault();
    e.stopPropagation();
  }, []);

  return (
    <div
      className="fixed end-3 z-40 flex items-center gap-2"
      style={{
        bottom: `calc(0.75rem + max(${keyboardInset}px + var(--keyboard-toolbar-height, 0px), var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))))`,
      }}
      onPointerDownCapture={handlePointerDown}
      onClickCapture={handleClick}
    >
      {children}
    </div>
  );
}

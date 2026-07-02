import * as React from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useMotionValue, animate } from "framer-motion";

import { cn } from "@/lib/utils";
import useKeyboardInset from "@/app/hooks/useKeyboardInset";

// A draggable, multi-detent bottom sheet built to replace vaul for the calendar
// preview.
//
// Why not vaul: vaul makes the whole sheet content draggable to dismiss, which
// intercepts the touches meant for the editor's caret/selection and, in
// non-modal mode, fights the calendar grid's own scroll and drag gestures. Here
// the grabber drags immediately, and the rest of the sheet becomes a drag
// surface only once a touch travels mostly-vertically past a slop threshold —
// and never when it starts on a surface that owns its own gestures (the canvas
// editor's caret/selection, text fields) or inside scrollable content that can
// consume the pan itself. Taps, horizontal pans, and grid touches behind a
// `peek` sheet stay native.
//
// Detents (snap points), as fractions of the viewport height:
//   • "peek"  — [compact, full]. Opens compact so the grid behind it stays
//     visible and interactive; drag the sheet up to snap to full and edit
//     everything by hand. Used for the new-event draft.
//   • "sheet" — [tall]. A single tall detent with a dimmed backdrop (tap to
//     close). Used for previewing an existing event.
//
// Once raised (by dragging up, or by focusing a keyboard field — see below), the
// sheet STAYS raised; it only collapses on an explicit downward drag. The soft
// keyboard overlays the WebView rather than shrinking it (Capacitor Keyboard
// `resize: "none"`), so window.innerHeight is constant and opening the keyboard
// never resizes the sheet — it holds still and its content is lifted above the
// keyboard by paddingBottom (the visualViewport inset) instead.
//
// Focusing a keyboard-raising field inside a peek DOES raise it to full, but the
// raise is DEFERRED a beat (KEYBOARD_RAISE_DELAY): the same tap that focuses the
// field also opens the soft keyboard, and iOS only raises the keyboard for a focus
// made synchronously in the gesture — so the focus can't be deferred, but the
// raise can. Starting the raise spring in that same tick, while the OS opens the
// keyboard on the main thread, stutters it; yielding that work first and animating
// on the next task keeps the raise smooth.
//
// Children own the vertical layout (the sheet is a flex column of fixed detent
// height): put a `shrink-0` header/footer at the edges and a `flex-1 min-h-0
// overflow-y-auto` region in the middle to keep the footer pinned.

const NON_KEYBOARD_INPUT_TYPES = new Set([
  "button",
  "submit",
  "reset",
  "checkbox",
  "radio",
  "range",
  "color",
  "file",
  "image",
]);

// Whether focusing `node` raises the soft keyboard: a text-like <input>, a
// <textarea>, or any contenteditable surface (how the editor takes text input).
function raisesKeyboard(node: EventTarget | null): boolean {
  const el = node as HTMLElement | null;
  if (!el || el.nodeType !== 1) return false;
  if (el.tagName === "TEXTAREA") return true;
  if (el.tagName === "INPUT") {
    return !NON_KEYBOARD_INPUT_TYPES.has((el as HTMLInputElement).type);
  }
  return el.isContentEditable === true;
}

const DISMISS_DRAG = 72; // px dragged below the smallest detent → dismiss
const DETENT_FLICK = 0.5; // px/ms flick that jumps one detent
const DISMISS_FLICK = 0.9; // px/ms downward flick at the smallest detent → dismiss
const GESTURE_SLOP = 8; // px a body touch must travel before it becomes a sheet drag
// After a keyboard-raising field inside a peek sheet focuses, wait this long
// before raising the sheet to full. The focus opens the soft keyboard in the same
// gesture (it can't be deferred — iOS won't raise the keyboard otherwise), so we
// defer the RAISE instead: yield the OS keyboard-open work off the main thread for
// a beat, then animate up cleanly.
const KEYBOARD_RAISE_DELAY = 80;

// Surfaces that own their pointer gestures outright: the canvas editor (caret
// and selection drags), contenteditable text, and anything opted out
// explicitly. A drag never starts from these. Text fields are exempt only
// while focused (see onSheetDown): a selection drag only exists on a focused
// field, and an unfocused one should drag the sheet like the row around it.
const DRAG_EXEMPT = 'canvas, [contenteditable="true"], [data-sheet-no-drag]';

// Whether a scrollable ancestor between `start` and `boundary` would consume a
// vertical pan of sign `dy` (+ = finger moving down). While the sheet is below
// its largest detent, an upward pan always grows the sheet first, so only a
// sheet already at max defers upward pans to inner scrollers.
function scrollableConsumes(
  start: HTMLElement | null,
  boundary: HTMLElement,
  dy: number,
  sheetAtMax: boolean,
): boolean {
  for (let el = start; el && el !== boundary; el = el.parentElement) {
    if (el.scrollHeight <= el.clientHeight + 1) continue;
    const overflowY = getComputedStyle(el).overflowY;
    if (overflowY !== "auto" && overflowY !== "scroll") continue;
    if (dy > 0 && el.scrollTop > 0) return true;
    if (
      dy < 0 &&
      sheetAtMax &&
      el.scrollTop < el.scrollHeight - el.clientHeight - 1
    ) {
      return true;
    }
  }
  return false;
}

const PEEK_SNAPS = [0.46, 0.92];
const SHEET_SNAPS = [0.85];

export function BottomSheet({
  open,
  onOpenChange,
  variant = "sheet",
  dismissible = true,
  className,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  variant?: "sheet" | "peek";
  dismissible?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const keyboardInset = useKeyboardInset();
  const keyboardOpen = keyboardInset > 0;
  const safeTop = "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))";
  const isFull = variant === "sheet";
  const snapFractions = isFull ? SHEET_SNAPS : PEEK_SNAPS;

  const [vh, setVh] = React.useState(() =>
    typeof window === "undefined" ? 800 : window.innerHeight,
  );
  React.useEffect(() => {
    const onResize = () => setVh(window.innerHeight);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Whether a keyboard-raising field inside the sheet holds focus — the trigger
  // for the deferred raise below. (Under Capacitor Keyboard resize:"none" the
  // keyboard no longer changes window.innerHeight, so detents need no keyboard-
  // free height snapshot; focus is tracked only to drive the raise.)
  const [inputFocused, setInputFocused] = React.useState(false);
  const handleFocus = React.useCallback((e: React.FocusEvent) => {
    if (raisesKeyboard(e.target)) setInputFocused(true);
  }, []);
  const handleBlur = React.useCallback((e: React.FocusEvent) => {
    if (!raisesKeyboard(e.relatedTarget)) setInputFocused(false);
  }, []);

  // Detents as pixel heights from the current viewport. window.innerHeight is a
  // stable screen height here: the keyboard overlays the WebView (resize:"none")
  // rather than shrinking it, so opening it never resizes the sheet. `vh` changes
  // only on a real screen-size change (rotation), which flows through below.
  const snaps = React.useMemo(
    () => snapFractions.map((f) => Math.round(vh * f)),
    [snapFractions, vh],
  );
  const lastIndex = snaps.length - 1;

  const [snapIndex, setSnapIndex] = React.useState(0);
  const height = useMotionValue(snaps[0]);
  const draggingRef = React.useRef(false);

  // The pixel height of a detent by index (clamped to the valid range).
  const resolveHeight = React.useCallback(
    (index: number) => snaps[Math.max(0, Math.min(index, snaps.length - 1))],
    [snaps],
  );

  // The in-flight height animation, if any. `height.set()` does NOT cancel a
  // running `animate(height, …)`, so every imperative write stops it first or the
  // two fight (a stale spring writing the value back the next frame).
  const heightAnimRef = React.useRef<{ stop: () => void } | null>(null);
  const setHeight = React.useCallback(
    (value: number) => {
      heightAnimRef.current?.stop();
      heightAnimRef.current = null;
      height.set(value);
    },
    [height],
  );
  const animateHeight = React.useCallback(
    (value: number) => {
      heightAnimRef.current?.stop();
      heightAnimRef.current = animate(height, value, {
        type: "spring",
        damping: 36,
        stiffness: 360,
      });
    },
    [height],
  );

  const snapTo = React.useCallback(
    (index: number) => {
      const clamped = Math.max(0, Math.min(index, snaps.length - 1));
      setSnapIndex(clamped);
      animateHeight(snaps[clamped]);
    },
    [snaps, animateHeight],
  );
  // Latest snapTo, read from the deferred-raise timeout so the effect below need
  // not re-run (and reschedule the raise) every time vh/detents change.
  const snapToRef = React.useRef(snapTo);
  snapToRef.current = snapTo;

  // Reset to the smallest detent whenever the sheet (re)opens.
  React.useEffect(() => {
    if (open) {
      setSnapIndex(0);
      setHeight(resolveHeight(0));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Re-fit the sheet to its detent when the screen size actually changes
  // (rotation) — not the keyboard, which no longer changes innerHeight. Animated,
  // not an instant set, so the adjustment is smooth. Skipped mid-drag.
  React.useEffect(() => {
    if (!draggingRef.current) {
      animateHeight(resolveHeight(snapIndex));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vh]);

  // Raise a peek sheet to full once a keyboard-raising field inside it focuses,
  // but a beat LATER (KEYBOARD_RAISE_DELAY) rather than in the focus handler: the
  // focus opens the soft keyboard, and starting the raise spring while the OS runs
  // that keyboard-open work on the main thread stutters it. The timeout yields
  // that work first, then animates up cleanly. Runs only when
  // `inputFocused` flips (not on every detent/vh change), and the cleanup cancels
  // a pending raise on blur, drag, close, or unmount so a quick tap-then-away
  // never yanks the sheet up after the fact. The single-detent "sheet" variant
  // has nothing to raise to, so it's a no-op there.
  React.useEffect(() => {
    if (!inputFocused || isFull) return;
    const id = setTimeout(() => {
      if (!draggingRef.current) snapToRef.current(lastIndex);
    }, KEYBOARD_RAISE_DELAY);
    return () => clearTimeout(id);
  }, [inputFocused, isFull, lastIndex]);

  const requestClose = React.useCallback(() => {
    if (dismissible) onOpenChange(false);
  }, [dismissible, onOpenChange]);

  // Escape closes (desktop / hardware keyboard).
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, requestClose]);

  // Sheet drag: resize the sheet, snapping to the nearest detent on release.
  // The grabber starts a drag immediately; anywhere else on the sheet becomes a
  // drag only after the touch travels mostly-vertically past GESTURE_SLOP (see
  // onSheetMove), so taps and gestures owned by the content stay native.
  const dragRef = React.useRef<{
    startY: number;
    startH: number;
    startIndex: number;
    lastY: number;
    lastT: number;
    v: number;
  } | null>(null);
  // A body touch that might become a drag once it clears the slop threshold.
  const pendingRef = React.useRef<{
    x: number;
    y: number;
    target: HTMLElement;
  } | null>(null);

  const beginDrag = (e: React.PointerEvent, captureEl: Element) => {
    // Grabbing the sheet dismisses the keyboard (and clears the focus that would
    // otherwise auto-raise it), so a downward drag can collapse it.
    (document.activeElement as HTMLElement | null)?.blur?.();
    // Take over any in-flight snap so the drag owns the height outright.
    heightAnimRef.current?.stop();
    heightAnimRef.current = null;
    captureEl.setPointerCapture(e.pointerId);
    draggingRef.current = true;
    dragRef.current = {
      startY: e.clientY,
      startH: height.get(),
      startIndex: snapIndex,
      lastY: e.clientY,
      lastT: e.timeStamp,
      v: 0,
    };
  };

  const onGrabDown = (e: React.PointerEvent) => {
    if (!dismissible || !e.isPrimary) return;
    beginDrag(e, e.currentTarget);
  };

  // Captured grabber events bubble through the sheet root, so the root's
  // move/up handlers below drive both grabber- and body-started drags.
  const onSheetDown = (e: React.PointerEvent) => {
    if (!dismissible || !e.isPrimary || dragRef.current) return;
    const target = e.target as HTMLElement;
    if (target.closest?.(DRAG_EXEMPT)) return;
    const field = target.closest?.("input, textarea, select");
    if (field && field === document.activeElement) return;
    pendingRef.current = { x: e.clientX, y: e.clientY, target };
  };
  const onSheetMove = (e: React.PointerEvent) => {
    const p = pendingRef.current;
    if (!dragRef.current && p) {
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      if (Math.abs(dy) >= GESTURE_SLOP && Math.abs(dy) > Math.abs(dx)) {
        pendingRef.current = null;
        // The claim point (not the down point) is the drag baseline, so the
        // sheet doesn't jump by the slop distance.
        if (
          !scrollableConsumes(
            p.target,
            e.currentTarget as HTMLElement,
            dy,
            snapIndex >= lastIndex,
          )
        ) {
          beginDrag(e, e.currentTarget);
        }
      } else if (Math.abs(dx) >= GESTURE_SLOP) {
        pendingRef.current = null; // horizontal gesture — not ours
      }
    }
    onDragMove(e);
  };
  const onSheetEnd = () => {
    pendingRef.current = null;
    endDrag();
  };

  // The scroll-vs-drag arbitration MUST happen in a non-passive touchmove
  // listener. `touch-action` on the sheet can't do it: a pan is checked only
  // against the chain from the touch target up to the scroller it would move,
  // so a value on the sheet root never restricts a scroller nested inside —
  // Chrome latches the pan onto that scroller and fires pointercancel, killing
  // the drag. Pointer events fire before their touch counterparts, so by the
  // first cancelable touchmove the handlers above have already recorded the
  // touch; preventing its default keeps the browser from ever starting a
  // scroll (or overscroll/pull-to-refresh) while a sheet drag is pending or
  // active, without touching gestures the content should keep (horizontal tag
  // rows, content scrolling at the max detent).
  const sheetRef = React.useRef<HTMLDivElement | null>(null);
  const sheetAtMax = snapIndex >= lastIndex;
  React.useEffect(() => {
    const el = sheetRef.current;
    if (!open || !el) return;
    const onTouchMove = (ev: TouchEvent) => {
      if (dragRef.current) {
        ev.preventDefault();
        return;
      }
      const p = pendingRef.current;
      const t = ev.touches[0];
      if (!p || !t) return;
      const dx = t.clientX - p.x;
      const dy = t.clientY - p.y;
      if (dx === 0 && dy === 0) return;
      if (
        Math.abs(dy) >= Math.abs(dx) &&
        !scrollableConsumes(p.target, el, dy, sheetAtMax)
      ) {
        ev.preventDefault();
      }
    };
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => el.removeEventListener("touchmove", onTouchMove);
  }, [open, sheetAtMax]);

  const onDragMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dy = e.clientY - d.startY;
    let h = d.startH - dy; // drag up (dy < 0) grows the sheet
    const min = snaps[0];
    const max = snaps[snaps.length - 1];
    if (h > max) h = max + (h - max) * 0.15; // resist above full
    if (h < min) h = min - (min - h) * 0.55; // resist below peek (dismiss zone)
    height.set(h);
    const dt = e.timeStamp - d.lastT;
    if (dt > 0) d.v = (e.clientY - d.lastY) / dt; // px/ms, + = downward
    d.lastY = e.clientY;
    d.lastT = e.timeStamp;
  };
  const endDrag = () => {
    const d = dragRef.current;
    dragRef.current = null;
    draggingRef.current = false;
    if (!d) return;
    const cur = height.get();
    const v = d.v;

    // Nearest detent to the released height, then bias by a flick.
    let nearest = 0;
    let best = Infinity;
    snaps.forEach((s, i) => {
      const dist = Math.abs(s - cur);
      if (dist < best) {
        best = dist;
        nearest = i;
      }
    });
    if (v < -DETENT_FLICK) nearest = Math.min(snaps.length - 1, nearest + 1);
    else if (v > DETENT_FLICK) nearest = Math.max(0, nearest - 1);

    // Dismiss only when pulling down from the smallest detent.
    if (
      d.startIndex === 0 &&
      (cur < snaps[0] - DISMISS_DRAG || v > DISMISS_FLICK)
    ) {
      requestClose();
      return;
    }
    snapTo(nearest);
  };

  // Only pad the portion of the top safe-area the sheet actually overlaps. A
  // detent that already rests below the status bar / notch needs no top inset,
  // so a tall-but-not-full sheet doesn't push the grabber down into dead space
  // above it. A truly full-screen sheet (top offset 0) still gets the full inset.
  const restingHeight = resolveHeight(snapIndex);
  const topOverlap = Math.max(0, vh - restingHeight);

  if (typeof document === "undefined") return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <>
          {isFull && (
            <motion.div
              className="fixed inset-0 z-50 bg-black/10 supports-backdrop-filter:backdrop-blur-xs"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              onPointerDown={requestClose}
            />
          )}
          <motion.div
            role="dialog"
            aria-modal={isFull}
            className={cn(
              "bg-background fixed inset-x-0 bottom-0 z-50 flex flex-col rounded-t-xl border-t text-sm",
              className,
            )}
            ref={sheetRef}
            style={{
              height,
              paddingTop: `calc(max(0px, ${safeTop} - ${topOverlap}px))`,
              // Keep the footer above the soft keyboard and the editor's global
              // fixed formatting toolbar (--keyboard-toolbar-height). A fixed
              // element doesn't follow the iOS visual viewport, hence reserving
              // the keyboard height here.
              paddingBottom: keyboardOpen
                ? `calc(${keyboardInset}px + var(--keyboard-toolbar-height, 0px))`
                : "calc(var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)) + var(--keyboard-toolbar-height, 0px))",
            }}
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", damping: 34, stiffness: 340 }}
            onFocus={handleFocus}
            onBlur={handleBlur}
            onPointerDown={onSheetDown}
            onPointerMove={onSheetMove}
            onPointerUp={onSheetEnd}
            onPointerCancel={onSheetEnd}
          >
            {/* Grabber — drags without any slop threshold, unlike the sheet
                body. Its captured events bubble to the root handlers above. */}
            <div
              className="shrink-0 cursor-grab touch-none pt-2 pb-1 active:cursor-grabbing"
              onPointerDown={onGrabDown}
            >
              <div className="bg-muted mx-auto h-1.5 w-[100px] rounded-full" />
            </div>
            {children}
          </motion.div>
        </>
      )}
    </AnimatePresence>,
    document.body,
  );
}

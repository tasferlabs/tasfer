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
// a dismiss/resize drag starts ONLY from the top grabber, so every other touch —
// on the editor, the fields, or the grid behind a `peek` sheet — stays native.
//
// Detents (snap points), as fractions of the viewport height:
//   • "peek"  — [compact, full]. Opens compact so the grid behind it stays
//     visible and interactive; drag the grabber up to snap to full and edit
//     everything by hand. Used for the new-event draft.
//   • "sheet" — [tall]. A single tall detent with a dimmed backdrop (tap to
//     close). Used for previewing an existing event.
//
// Once raised — by dragging up OR auto-raised when a field/editor focuses — the
// sheet STAYS raised. It only collapses on an explicit downward drag.
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
  const snaps = React.useMemo(
    () => snapFractions.map((f) => Math.round(vh * f)),
    [snapFractions, vh],
  );
  const lastIndex = snaps.length - 1;

  const [snapIndex, setSnapIndex] = React.useState(0);
  const height = useMotionValue(snaps[0]);
  const draggingRef = React.useRef(false);

  const snapTo = React.useCallback(
    (index: number) => {
      const clamped = Math.max(0, Math.min(index, snaps.length - 1));
      setSnapIndex(clamped);
      animate(height, snaps[clamped], {
        type: "spring",
        damping: 36,
        stiffness: 360,
      });
    },
    [height, snaps],
  );

  // Reset to the smallest detent whenever the sheet (re)opens.
  React.useEffect(() => {
    if (open) {
      setSnapIndex(0);
      height.set(snaps[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Track the resting height if the viewport changes while not mid-drag.
  React.useEffect(() => {
    if (!draggingRef.current) {
      height.set(snaps[Math.min(snapIndex, snaps.length - 1)]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vh]);

  // Auto-raise to the largest detent when a field/editor focuses or the keyboard
  // opens. Never auto-collapse — the user must drag down explicitly.
  const [inputFocused, setInputFocused] = React.useState(false);
  const handleFocus = React.useCallback((e: React.FocusEvent) => {
    if (raisesKeyboard(e.target)) setInputFocused(true);
  }, []);
  const handleBlur = React.useCallback((e: React.FocusEvent) => {
    if (!raisesKeyboard(e.relatedTarget)) setInputFocused(false);
  }, []);
  React.useEffect(() => {
    if (open && (keyboardOpen || inputFocused)) snapTo(lastIndex);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyboardOpen, inputFocused, open]);

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

  // Grabber drag: resize the sheet, snapping to the nearest detent on release.
  const dragRef = React.useRef<{
    startY: number;
    startH: number;
    startIndex: number;
    lastY: number;
    lastT: number;
    v: number;
  } | null>(null);

  const onGrabDown = (e: React.PointerEvent) => {
    if (!dismissible) return;
    // Grabbing the sheet dismisses the keyboard (and clears the focus that would
    // otherwise auto-raise it), so a downward drag can collapse it.
    (document.activeElement as HTMLElement | null)?.blur?.();
    e.currentTarget.setPointerCapture(e.pointerId);
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
  const onGrabMove = (e: React.PointerEvent) => {
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
  const endGrab = () => {
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

  const atNotch = snapFractions[snapIndex] >= 0.9;

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
            style={{
              height,
              paddingTop: atNotch ? safeTop : undefined,
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
          >
            {/* Grabber — the only drag surface, so editor/field/grid touches
                stay native. */}
            <div
              className="shrink-0 cursor-grab touch-none pt-2 pb-1 active:cursor-grabbing"
              onPointerDown={onGrabDown}
              onPointerMove={onGrabMove}
              onPointerUp={endGrab}
              onPointerCancel={endGrab}
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

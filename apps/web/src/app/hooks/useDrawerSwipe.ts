import React from "react";

/**
 * Discord-style drag for the mobile sidebar: pull the page aside from anywhere
 * on it to bring in the drawer, push it back to close.
 *
 * The gesture is not confined to a hot zone at the screen edge. That is what
 * separates it from a Material drawer, and it is also what keeps it working on
 * Android and in mobile Chrome, where the system claims the outermost strip of
 * both edges and the page never sees a touch that starts there. The edge is
 * not meaningless, though: a drag that starts there outranks a surface that
 * would otherwise keep the sideways drag for itself.
 *
 * The drawer is driven imperatively rather than from React state — a re-render
 * per touchmove would take the whole spaces tree with it. That makes this hook
 * the only writer of its transform, so the open prop feeds in through the same
 * `applyProgress` path a drag does and the two can never disagree about where
 * the panel sits.
 */

/**
 * How far in from the inline-start edge a drag outranks whatever is under it.
 * A drag may begin anywhere; beginning here is what lets it win against a
 * surface that owns sideways drags of its own — the calendar's day strip fills
 * the screen it is on, and the drawer has to stay reachable over it.
 */
const EDGE_ZONE_PX = 44;
/** Movement before we decide a drag is horizontal rather than a scroll. */
const AXIS_LOCK_PX = 12;
/**
 * The same for a drag off the edge, which has to settle the question before the
 * surface underneath does. Deliberately under the 8px those surfaces take to
 * commit: we lock first, and stop the move that would have locked them from
 * ever reaching them.
 */
const EDGE_AXIS_LOCK_PX = 6;
/** How far horizontal has to beat vertical for the drag to be ours. */
const AXIS_DOMINANCE = 1.5;
/** Mirrors the sidebar tree's TouchSensor delay — see SidebarContent. */
const DND_DELAY_MS = 300;
/** px/ms past which a flick commits regardless of distance travelled. */
const FLICK_VELOCITY = 0.35;
/** Fraction of the drawer's width a slow drag must cross to commit. */
const COMMIT_FRACTION = 0.4;
const SETTLE_MS = 280;
const SETTLE_EASE = "cubic-bezier(0.32, 0.72, 0, 1)";

/**
 * Surfaces that own a horizontal drag of their own. Anything else that grows
 * one opts out the same way, by marking itself `data-drawer-swipe="off"`.
 */
const OWNED_ELSEWHERE =
  '[data-drawer-swipe="off"],[role="slider"],[role="separator"]';

/**
 * True when something under the finger has its own claim on a sideways drag —
 * an opted-out surface, or a strip that scrolls horizontally. Only consulted
 * away from the edge; an edge drag outranks the answer. Reading the computed
 * style is gated on the element actually overflowing, so the common case walks
 * the ancestors and touches layout only.
 */
function claimedByContent(target: EventTarget | null) {
  let el: Element | null = target instanceof Element ? target : null;
  while (el) {
    if (el.matches(OWNED_ELSEWHERE)) return true;
    if (el.scrollWidth - el.clientWidth > 1) {
      const overflowX = getComputedStyle(el).overflowX;
      if (overflowX === "auto" || overflowX === "scroll") return true;
    }
    el = el.parentElement;
  }
  return false;
}

/**
 * The gesture is over, as far as whatever was under the finger is concerned.
 * Cancelling is the platform's own way of saying a parent has taken a touch
 * over, and both surfaces that care here honour it — the editor tears down a
 * long press and its magnifier, the calendar drops its half-swipe.
 *
 * Handlers on this path read nothing off the event, so a plain Event is enough
 * wherever the TouchEvent constructor is missing.
 */
function dispatchCancel(target: EventTarget, touch: Touch) {
  let event: Event;
  try {
    event = new TouchEvent("touchcancel", {
      bubbles: true,
      cancelable: false,
      touches: [],
      targetTouches: [],
      changedTouches: [touch],
    });
  } catch {
    event = new Event("touchcancel", { bubbles: true });
  }
  target.dispatchEvent(event);
}

export default function useDrawerSwipe({
  open,
  setOpen,
  isRtl,
  ownsGesture,
}: {
  open: boolean;
  setOpen: (open: boolean) => void;
  isRtl: boolean;
  /**
   * Asked once, at the moment the drag would become ours: is some other
   * surface already in a gesture of its own on this touch? The canvas answers
   * for the editor — a selection handle being dragged sideways, a caret pulled
   * along a line — and those cannot be told apart from the outside: the canvas
   * is one element with no DOM under it to mark, and the touch reaches this
   * hook (window, capture phase) before the canvas has even seen it, so the
   * question has to be asked later than {@link claimedByContent}, not answered
   * up front. Yes outranks everything here, the edge zone included: the finger
   * is on a handle the user can see.
   */
  ownsGesture?: () => boolean;
}) {
  const drawerRef = React.useRef<HTMLDivElement | null>(null);
  // Read through a ref so a new closure per render never re-subscribes.
  const ownsGestureRef = React.useRef(ownsGesture);
  ownsGestureRef.current = ownsGesture;

  const applyProgress = React.useCallback(
    (progress: number, animate: boolean) => {
      const drawer = drawerRef.current;
      if (!drawer) return;
      const offset = (isRtl ? 100 : -100) * (1 - progress);
      drawer.style.transition = animate
        ? `transform ${SETTLE_MS}ms ${SETTLE_EASE}`
        : "none";
      drawer.style.transform = `translateX(${offset}%)`;
    },
    [isRtl],
  );

  // The first application places the drawer; animating it would slide the panel
  // in on load for anyone who left it open.
  const hasPlaced = React.useRef(false);
  React.useLayoutEffect(() => {
    applyProgress(open ? 1 : 0, hasPlaced.current);
    hasPlaced.current = true;
  }, [open, applyProgress]);

  React.useEffect(() => {
    const start = { x: 0, y: 0, time: 0 };
    let tracking = false;
    let active = false;
    let fromEdge = false;
    let startTarget: EventTarget | null = null;
    // Our own listeners see the cancel we send, and must not read it as the
    // user lifting a finger.
    let cancelling = false;
    let width = 1;
    let progress = open ? 1 : 0;
    let lastX = 0;
    let lastTime = 0;
    let velocity = 0;

    function onTouchStart(e: TouchEvent) {
      if (e.touches.length !== 1) return;
      const drawer = drawerRef.current;
      if (!drawer) return;
      // A modal marks everything behind it hidden from assistive tech, and the
      // drawer is part of what it covers. Pulling it out from under a dialog is
      // not a gesture the user can mean.
      if (drawer.closest('[aria-hidden="true"]')) return;
      const touch = e.touches[0];

      fromEdge = false;
      if (open) {
        // Open, the drawer is the whole screen; a touch that lands anywhere
        // else is on something stacked above it and not ours to act on.
        const target = e.target as Node | null;
        if (!target || !drawer.contains(target)) return;
      } else {
        fromEdge = isRtl
          ? touch.clientX >= window.innerWidth - EDGE_ZONE_PX
          : touch.clientX <= EDGE_ZONE_PX;
        if (!fromEdge && claimedByContent(e.target)) return;
      }

      startTarget = e.target;
      start.x = touch.clientX;
      start.y = touch.clientY;
      start.time = e.timeStamp;
      lastX = touch.clientX;
      lastTime = e.timeStamp;
      velocity = 0;
      width = drawer.getBoundingClientRect().width || 1;
      progress = open ? 1 : 0;
      tracking = true;
      active = false;
    }

    function onTouchMove(e: TouchEvent) {
      if (!tracking) return;
      if (e.touches.length !== 1) {
        settle(true);
        return;
      }
      const touch = e.touches[0];
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;

      if (!active) {
        // Held still this long and the touch belongs to whatever acts on a
        // long press — dnd-kit's page reordering in the sidebar tree, the
        // canvas's own drag-select on a page.
        if (e.timeStamp - start.time > DND_DELAY_MS) {
          tracking = false;
          return;
        }
        const lock = fromEdge ? EDGE_AXIS_LOCK_PX : AXIS_LOCK_PX;
        if (Math.abs(dx) < lock && Math.abs(dy) < lock) return;
        const inward = isRtl ? dx < 0 : dx > 0;
        // Now that a drag may start anywhere, almost every touch on the page is
        // a candidate and scrolling is the gesture we must not steal: take only
        // a clearly sideways drag, and only in the direction that would change
        // the drawer's state.
        if (Math.abs(dx) <= Math.abs(dy) * AXIS_DOMINANCE || inward === open) {
          tracking = false;
          return;
        }
        if (ownsGestureRef.current?.()) {
          tracking = false;
          return;
        }
        active = true;
        // Tell what the touch started on that it has lost it. Silence alone is
        // not enough: the editor's long press runs off a clock rather than off
        // movement, so a suppressed drag is exactly a finger it believes is
        // being held still — it buzzes and raises the magnifier, and with the
        // release suppressed too, never takes it back down.
        if (startTarget) {
          cancelling = true;
          try {
            dispatchCancel(startTarget, touch);
          } finally {
            cancelling = false;
          }
        }
      }

      // Nothing below gets to act on the rest of the drag either: no
      // day-panning under an edge drag, no caret dragged across the canvas, no
      // flick that the editor would read as a tap and answer by raising the
      // keyboard. Listening in the capture phase is what makes this early
      // enough to matter.
      e.stopPropagation();
      e.preventDefault();
      const travelled = (isRtl ? -dx : dx) / width;
      progress = Math.min(1, Math.max(0, (open ? 1 : 0) + travelled));
      applyProgress(progress, false);

      const elapsed = e.timeStamp - lastTime;
      if (elapsed > 0) velocity = (touch.clientX - lastX) / elapsed;
      lastX = touch.clientX;
      lastTime = e.timeStamp;
    }

    function settle(revert: boolean) {
      const wasActive = active;
      tracking = false;
      active = false;
      if (!wasActive) return;

      if (revert) {
        applyProgress(open ? 1 : 0, true);
        return;
      }

      const inwardVelocity = isRtl ? -velocity : velocity;
      const travelled = open ? 1 - progress : progress;
      const target =
        Math.abs(inwardVelocity) > FLICK_VELOCITY
          ? inwardVelocity > 0
          : travelled > COMMIT_FRACTION
            ? !open
            : open;

      applyProgress(target ? 1 : 0, true);
      setOpen(target);
    }

    // The release belongs to the drag too: a handler that never saw the moves
    // would read the touch ending as a tap on whatever it started over.
    const onTouchEnd = (e: TouchEvent) => {
      if (active) e.stopPropagation();
      settle(false);
    };
    const onTouchCancel = (e: TouchEvent) => {
      if (cancelling) return;
      if (active) e.stopPropagation();
      settle(true);
    };

    const capture = { capture: true };
    window.addEventListener("touchstart", onTouchStart, {
      ...capture,
      passive: true,
    });
    window.addEventListener("touchmove", onTouchMove, {
      ...capture,
      passive: false,
    });
    window.addEventListener("touchend", onTouchEnd, capture);
    window.addEventListener("touchcancel", onTouchCancel, capture);
    return () => {
      window.removeEventListener("touchstart", onTouchStart, capture);
      window.removeEventListener("touchmove", onTouchMove, capture);
      window.removeEventListener("touchend", onTouchEnd, capture);
      window.removeEventListener("touchcancel", onTouchCancel, capture);
    };
  }, [open, isRtl, applyProgress, setOpen]);

  return { drawerRef };
}

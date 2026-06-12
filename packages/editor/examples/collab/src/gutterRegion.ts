/**
 * Custom interaction region — drag the left gutter to scroll.
 *
 * Regions are the new shared input contract: a canvas hit-area that owns its
 * own hit detection and tap/drag behavior, working identically under mouse and
 * touch (the editor's built-in scrollbar, selection handles, and peer markers
 * are all regions now). Hosts add their own via `createEditor({ regions })`.
 *
 * This one claims the empty left margin and turns a drag there into a scroll —
 * a tiny "scrub bar". It's view-only: it never mutates document state, it just
 * calls `ctx.updateViewport({ scrollY })`. Handlers return new state (or `null`
 * to decline and fall through), never mutating in place — the same functional
 * contract as the rest of the event layer.
 *
 * It's built by a FACTORY so the in-flight gesture (`startPointerY` /
 * `startScrollY`) lives in a per-instance closure, not a module global — two
 * editors on one page must not share gesture state (the project's
 * no-shared-mutable-state rule). Each editor gets its own region instance.
 */
import type { Region } from "@cypherkit/editor";

/** Width of the grab strip on the left edge, in canvas px (touch gets more slop). */
const GUTTER_MOUSE = 20;
const GUTTER_TOUCH = 28;

export function createGutterScrollRegion(): Region {
  // Per-instance gesture state — captured between onStart and onMove.
  let startPointerY = 0;
  let startScrollY = 0;

  return {
    id: "gutter-scroll",
    // Below the scrollbar (100) and handles (80) so it never steals those, but
    // above nothing in particular — it only fires in the otherwise-dead margin.
    priority: 50,
    // Active even in read-only documents: scrolling should always work.
    modes: ["edit", "select", "readonly"],

    // Lazy hit test against the live pointer. Return any truthy "hit" payload
    // (we don't need one) or null to decline. Apply pointer-type slop here.
    hitTest(p, pointerType) {
      const gutter = pointerType === "touch" ? GUTTER_TOUCH : GUTTER_MOUSE;
      return p.x <= gutter ? true : null;
    },

    drag: {
      // Returning a (truthy) result captures the pointer: every later move/up
      // routes here until release, so the gesture can't be stolen mid-drag.
      onStart(_hit, p, ctx) {
        startPointerY = p.y;
        startScrollY = ctx.viewport.scrollY;
        return { state: ctx.state };
      },
      onMove(p, ctx) {
        const maxScroll = Math.max(
          0,
          ctx.documentHeight - ctx.viewport.height,
        );
        const next = startScrollY - (p.y - startPointerY);
        ctx.updateViewport?.({
          scrollY: Math.max(0, Math.min(maxScroll, next)),
        });
        return { state: ctx.state };
      },
      // Nothing to commit on release — decline so the capture simply clears.
      onEnd() {
        return null;
      },
      onCancel(ctx) {
        return ctx.state;
      },
    },
  };
}

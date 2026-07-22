/**
 * Regression: a captured drag (touch selection handle) must re-resolve the
 * pointer against the painted `visibility` snapshot.
 *
 * A selection handle is a *captured* region: once grabbed, every touchmove is
 * routed straight to its `drag.onMove` via `routeCapturedMove`, bypassing the
 * normal tap/hit-test path. That `onMove` maps the finger to a document position
 * with `getTextPositionFromViewport`, which only anchors on the paint when given
 * `visibility`. Without it the walk sums exact heights from block 0, which drifts
 * from the estimate-anchored paint on a long, scrolled document whose off-screen
 * blocks mis-estimate their height (wrapped list/todo items) — so a small handle
 * drag snaps the selection far from the finger, even with no scrolling.
 *
 * handleTouchMove must therefore thread `visibility` into the captured-drag
 * context. This pins that wiring with a stand-in captured region that records
 * the context it receives.
 */

import { AtomicNode } from "../rendering/nodes/AtomicNode";
import type {
  BlockRuntimeState,
  NodeLayoutCtx,
  NodePaintCtx,
} from "../rendering/nodes/Node";
import { NodeRegistry } from "../rendering/nodes/Node";
import type { Block, Page } from "../serlization/loadPage";
import type {
  BlockBounds,
  EditorState,
  ViewportState,
  VisibleBlockRange,
} from "../state-types";
import { createInitialState } from "../state-utils";
import { generateNKeysBetween } from "../sync/fractional-index";
import { createChromeRegionRegistry } from "./chromeRegions";
import { createInteractionSession } from "./interaction-session";
import type { Region } from "./regions";
import { handleTouchMove } from "./touchEvents";
import { describe, expect, it } from "vitest";

interface TestBlock extends BlockRuntimeState {
  type: "para";
}

class FixedHeightNode extends AtomicNode<TestBlock> {
  readonly type = "para" as const;
  protected intrinsicHeight(_c: NodeLayoutCtx): number {
    return 40;
  }
  protected draw(_box: BlockBounds, _c: NodePaintCtx): void {}
}

function baseState(): EditorState {
  const keys = generateNKeysBetween(null, null, 5);
  const blocks = Array.from(
    { length: 5 },
    (_, i) =>
      ({
        id: `b${i}`,
        orderKey: keys[i],
        type: "para",
        charRuns: [],
        formats: [],
      }) as unknown as Block,
  );
  const page: Page = { id: "page", title: "", blocks };
  return createInitialState(page, {
    nodes: new NodeRegistry().register(new FixedHeightNode()),
  });
}

function touchEvent(x: number, y: number): TouchEvent {
  return {
    touches: [{ clientX: x, clientY: y }],
    changedTouches: [{ clientX: x, clientY: y }],
    preventDefault: () => {},
  } as unknown as TouchEvent;
}

describe("captured drag threads the visibility snapshot", () => {
  it("routes the painted visibility snapshot into the captured drag's onMove", () => {
    let receivedVisibility: VisibleBlockRange | undefined | "unset" = "unset";

    // Stand-in captured region: record the context's visibility on each move.
    const recordingRegion = {
      id: "test-capture",
      priority: 1,
      modes: ["edit"],
      hitTest: () => null,
      drag: {
        onStart: (_hit: unknown, _p: unknown, ctx: { state: EditorState }) => ({
          state: ctx.state,
        }),
        onMove: (
          _p: unknown,
          ctx: { state: EditorState; visibility?: VisibleBlockRange },
        ) => {
          receivedVisibility = ctx.visibility;
          return { state: ctx.state };
        },
        onEnd: (_p: unknown, ctx: { state: EditorState }) => ({
          state: ctx.state,
        }),
        onCancel: (ctx: { state: EditorState }) => ctx.state,
      },
    } as unknown as Region;

    const session = createInteractionSession(createChromeRegionRegistry());
    session.captured = { region: recordingRegion, hit: null };

    const viewport: ViewportState = {
      width: 600,
      height: 800,
      scrollY: 4_000,
      documentHeight: 40_000,
    };
    const visibility: VisibleBlockRange = { start: 100, end: 120, startY: 12 };

    handleTouchMove(
      baseState(),
      viewport,
      touchEvent(300, 400),
      { left: 0, top: 0 },
      viewport.documentHeight,
      session,
      undefined,
      visibility,
    );

    expect(receivedVisibility).toBe(visibility);
  });
});

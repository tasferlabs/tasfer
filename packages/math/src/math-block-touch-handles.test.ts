/**
 * Touch selection handles on part of a block equation.
 *
 * A range inside a `$$…$$` block used to draw no handles on a phone: the
 * equation gave core no handle geometry for it, so a double-tapped piece
 * could not be grown or shrunk. Now the handles hang off the equation's own
 * highlight and follow the finger, the same as inside an inline formula.
 */

import { mathExtension } from "./math-extension";
import { getMathStructuredDocument } from "./structured";
import {
  mathContentSelectionFromSourceOffset,
  mathSourceRangeFromContentSelection,
} from "./tree-selection";
import { TAP_SELECT_WORD } from "@tasfer/editor/actions/touch-actions";
import { hitTestAllRegions } from "@tasfer/editor/events/blockRegions";
import { createChromeRegionRegistry } from "@tasfer/editor/events/chromeRegions";
import { getTouchSelectionHandlePositions } from "@tasfer/editor/events/eventUtils";
import {
  createInteractionSession,
  type InteractionSession,
} from "@tasfer/editor/events/interaction-session";
import {
  beginRegionInteraction,
  routeCapturedEnd,
  routeCapturedMove,
} from "@tasfer/editor/events/regions";
import { createMarkRegistry } from "@tasfer/editor/rendering/marks";
import { createNodeRegistry } from "@tasfer/editor/rendering/nodes";
import { baseSchema } from "@tasfer/editor/schema";
import {
  getTextPositionFromViewport,
  getWordRangeFromViewport,
  isPointWithinSelectionRects,
  moveCursorToPosition,
} from "@tasfer/editor/selection";
import { loadPage } from "@tasfer/editor/serlization/loadPage";
import type { EditorState, ViewportState } from "@tasfer/editor/state-types";
import { createInitialState } from "@tasfer/editor/state-utils";
import { updateContentSelection } from "@tasfer/editor/structured-selection";
import { getEditorStyles } from "@tasfer/editor/styles";
import { createCRDTbinding } from "@tasfer/editor/sync/sync";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  // The scrollbar hit-test probes the safe-area inset through document.body.
  const d = (globalThis as unknown as { document: Record<string, unknown> })
    .document;
  if (!d.body) d.body = { appendChild: () => {}, removeChild: () => {} };
});

const schema = baseSchema.use(mathExtension());

const viewport: ViewportState = {
  width: 600,
  height: 800,
  scrollY: 0,
  documentHeight: 1000,
};

/** Load a page; the equation is the block at `index`. */
function load(markdown: string, index = 0) {
  const state = moveCursorToPosition(
    createInitialState(loadPage(markdown, schema.data), {
      schema: schema.data,
      nodes: createNodeRegistry(schema.nodes),
      marks: createMarkRegistry(schema.marks),
      crdtBinding: createCRDTbinding("page", "peer"),
    }),
    0,
    0,
  );
  const block = state.document.page.blocks[index];
  const document = getMathStructuredDocument(block);
  if (!document) throw new Error("expected a block equation");

  /** Select source `[from, to)` inside the equation. */
  const select = (from: number, to: number): EditorState => {
    const at = (offset: number) =>
      mathContentSelectionFromSourceOffset(
        block.id,
        document.rootId,
        document,
        offset,
      );
    const a = at(from);
    const f = at(to);
    if (!a || !f) throw new Error("expected nested carets");
    return updateContentSelection(state, {
      anchor: a.anchor,
      focus: f.focus,
      lastUpdate: 0,
    });
  };

  /** The selected source range inside the equation, or null for none. */
  const range = (s: EditorState) =>
    s.document.contentSelection
      ? mathSourceRangeFromContentSelection(
          document,
          s.document.contentSelection,
        )
      : null;

  return { state, select, range };
}

/** The centre of a handle's ball, in viewport space. */
function ballOf(state: EditorState, which: "anchor" | "focus") {
  const handle = getTouchSelectionHandlePositions(state, viewport)?.[which];
  if (!handle) throw new Error(`expected a ${which} handle`);
  const { size, stemHeight } = getEditorStyles(state).selection.handles;
  return {
    x: handle.x,
    y: handle.isTop
      ? handle.y - stemHeight - size / 2
      : handle.y + handle.height + stemHeight + size / 2,
  };
}

/**
 * Grab a handle by its ball; returns a mover that drags the ball by `dx`
 * sideways and `dy` up or down from where it was grabbed.
 */
function grab(start: EditorState, which: "anchor" | "focus") {
  const session: InteractionSession = createInteractionSession(
    createChromeRegionRegistry(),
  );
  const ball = ballOf(start, which);
  const ctx = {
    state: start,
    viewport,
    documentHeight: viewport.documentHeight,
    session,
    visibility: undefined,
  } as never;
  const claim = hitTestAllRegions(ball, "touch", ctx);
  expect(claim?.region.id).toBe("selection-handle");
  expect(claim?.hit).toBe(which);
  let state = (
    beginRegionInteraction(claim!, ball, "touch", ctx) as {
      state: EditorState;
    }
  ).state;
  const routeCtx = () =>
    ({
      state,
      viewport,
      documentHeight: viewport.documentHeight,
      session,
      updateViewport: undefined,
    }) as never;
  const move = (dx: number, dy = 0): EditorState => {
    state = routeCapturedMove(
      { x: ball.x + dx, y: ball.y + dy },
      routeCtx(),
    )!.state;
    return state;
  };
  /** Lift the finger. */
  const release = (): EditorState => {
    state = routeCapturedEnd(null, routeCtx())!.state;
    return state;
  };
  return Object.assign(move, { release });
}

describe("handles on part of a block equation", () => {
  it("hangs both handles off the selected part", () => {
    const { select } = load("$$abcdefg$$");
    const handles = getTouchSelectionHandlePositions(select(2, 4), viewport);

    expect(handles?.anchor?.isTop).toBe(true);
    expect(handles?.focus?.isTop).toBe(false);
    expect(handles!.focus!.x).toBeGreaterThan(handles!.anchor!.x);
  });

  it("puts the start handle on the left when the range runs backwards", () => {
    const { select } = load("$$abcdefg$$");
    const handles = getTouchSelectionHandlePositions(select(4, 2), viewport);

    expect(handles?.anchor?.isTop).toBe(false);
    expect(handles?.focus?.isTop).toBe(true);
    expect(handles!.focus!.x).toBeLessThan(handles!.anchor!.x);
  });

  it("draws no handles for a caret", () => {
    const { select } = load("$$abcdefg$$");

    expect(getTouchSelectionHandlePositions(select(3, 3), viewport)).toBeNull();
  });

  it("gives a double-tapped piece handles", () => {
    const { state, range } = load("$$abcdefg$$");
    const handles = getTouchSelectionHandlePositions(state, viewport);
    expect(handles).toBeNull();

    const x = 300;
    const y = 45;
    const position = getTextPositionFromViewport(x, y, state, viewport);
    const word = getWordRangeFromViewport(
      x,
      y,
      state,
      viewport,
      getEditorStyles(state),
    );
    const tapped = state.actionBus.dispatchState(TAP_SELECT_WORD, state, {
      position: position!,
      range: word ?? undefined,
    }).state;

    expect(range(tapped)).not.toBeNull();
    const after = getTouchSelectionHandlePositions(tapped, viewport);
    expect(after?.anchor).toBeTruthy();
    expect(after?.focus).toBeTruthy();
  });

  it("treats a touch on the selected part as a touch on the selection", () => {
    const { select } = load("$$abcdefg$$");
    const state = select(2, 4);
    const handles = getTouchSelectionHandlePositions(state, viewport)!;
    const midX = (handles.anchor!.x + handles.focus!.x) / 2;
    const midY = handles.anchor!.y + handles.anchor!.height / 2;

    expect(isPointWithinSelectionRects(midX, midY, state, viewport)).toBe(true);
  });

  it("grows and shrinks the part as the end handle's ball is dragged", () => {
    const { select, range } = load("$$abcdefg$$");
    const drag = grab(select(2, 4), "focus");

    expect(range(drag(20))).toEqual({ from: 2, to: 6 });
    expect(range(drag(-10))).toEqual({ from: 2, to: 3 });
  });

  it("moves the start of the part with the start handle", () => {
    const { select, range } = load("$$abcdefg$$");
    const drag = grab(select(2, 4), "anchor");

    expect(range(drag(-20))).toEqual({ from: 0, to: 4 });
    expect(range(drag(10))).toEqual({ from: 3, to: 4 });
  });

  it("keeps the part when the handle wobbles up and down", () => {
    const { select, range } = load("$$abcdefg$$");
    const drag = grab(select(2, 4), "focus");

    for (const dy of [-8, -4, 4, 8, 0]) {
      expect(range(drag(0, dy))).toEqual({ from: 2, to: 4 });
    }
  });

  it("ends the drag when the finger lifts, keeping the range", () => {
    const { select, range } = load("$$abcdefg$$");
    const drag = grab(select(2, 4), "focus");
    drag(20);
    const released = drag.release();

    expect(released.ui.selectionHandleDrag).toBeNull();
    expect(range(released)).toEqual({ from: 2, to: 6 });
  });
});

describe("a handle crossing a root in a block equation", () => {
  const md = "$$ab\\sqrt{cde}fg$$";

  it("takes the root only once the finger is past its middle", () => {
    const { select, range } = load(md);
    const drag = grab(select(0, 1), "focus");

    const before = drag(24);
    expect(range(before)).toEqual({ from: 0, to: 2 });
    expect(before.ui.selectionHandleDrag?.crossing?.counted).toBe(false);

    const after = drag(42);
    expect(range(after)).toEqual({ from: 0, to: 12 });
    expect(after.ui.selectionHandleDrag?.crossing?.counted).toBe(true);
  });

  it("shades the crossed part as strongly as the equation's own highlight", () => {
    const { select } = load(md);
    const drag = grab(select(0, 1), "focus");
    const crossing = drag(24).ui.selectionHandleDrag?.crossing;

    expect(crossing?.opacity).toBe(
      getEditorStyles(drag(24)).blocks.math.selectionOpacity,
    );
  });
});

describe("a handle dragged across a fraction's rows", () => {
  const md = "above\n\n$$x+\\frac{abc}{def}+y$$\n\nbelow";

  it("takes the whole fraction once the handle reaches the other row", () => {
    const { select, range } = load(md, 2);
    const drag = grab(select(8, 9), "focus");

    expect(range(drag(0, 30))).toEqual({ from: 2, to: 17 });
  });

  it("keeps the range in the equation when the handle leaves it", () => {
    const { select, range } = load(md, 2);
    const drag = grab(select(8, 9), "focus");
    const moved = drag(0, -80);

    expect(moved.document.selection).toBeNull();
    expect(range(moved)).toEqual({ from: 8, to: 9 });
  });
});

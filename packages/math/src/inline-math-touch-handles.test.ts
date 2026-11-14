/**
 * Touch selection handles on part of an inline formula.
 *
 * Two things used to go wrong on a phone:
 *   • a range INSIDE a formula drew no handles (the paragraph gave core no
 *     handle geometry for it), and a drag of the handle's ball — which hangs
 *     below the text — missed the formula's rows, so the range never moved;
 *   • a double-tap selects the whole formula as one flat character, and the
 *     flat handles could only take that character whole or drop it.
 *
 * Now the handles hang off the formula's own highlight, follow the finger's
 * motion, and a handle dragged into a wholly selected formula continues as a
 * range inside it. A range takes a construct (a √) whole or not at all, so a
 * handle crossing one is drawn under the finger, and the construct counts
 * once the finger is past its middle.
 */

import { resolveStructuredInlineMathRuns } from "./inline-structured";
import { mathExtension } from "./math-extension";
import {
  mathContentSelectionFromSourceOffset,
  mathSourceRangeFromContentSelection,
} from "./tree-selection";
import { CURSOR_DRAG_BOUNDARY } from "@tasfer/editor/action-bus";
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
import { isTextualBlock } from "@tasfer/editor/sync/block-registry";
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

function load(markdown: string): EditorState {
  const state = createInitialState(loadPage(markdown, schema.data), {
    schema: schema.data,
    nodes: createNodeRegistry(schema.nodes),
    marks: createMarkRegistry(schema.marks),
    crdtBinding: createCRDTbinding("page", "peer"),
  });
  return moveCursorToPosition(state, 0, 1);
}

function chip(state: EditorState) {
  const block = state.document.page.blocks[0];
  if (!isTextualBlock(block)) throw new Error("expected a textual block");
  const run = resolveStructuredInlineMathRuns(block)[0];
  if (!run?.contentId || !run.document) throw new Error("expected a chip");
  return { block, contentId: run.contentId, document: run.document };
}

/** Select source `[from, to)` inside the block's only formula. */
function selectInside(state: EditorState, from: number, to: number) {
  const { block, contentId, document } = chip(state);
  const a = mathContentSelectionFromSourceOffset(
    block.id,
    contentId,
    document,
    from,
  );
  const f = mathContentSelectionFromSourceOffset(
    block.id,
    contentId,
    document,
    to,
  );
  if (!a || !f) throw new Error("expected nested carets");
  return updateContentSelection(state, {
    anchor: a.anchor,
    focus: f.focus,
    lastUpdate: 0,
  });
}

/** The selected source range inside the formula, or null for none. */
function insideRange(state: EditorState) {
  const content = state.document.contentSelection;
  if (!content) return null;
  return mathSourceRangeFromContentSelection(chip(state).document, content);
}

/** Double-tap the formula, the way a phone selects it. */
function doubleTapFormula(state: EditorState, x: number): EditorState {
  const y = 12;
  const position = getTextPositionFromViewport(x, y, state, viewport);
  if (!position) throw new Error("expected a position under the tap");
  const range = getWordRangeFromViewport(
    x,
    y,
    state,
    viewport,
    getEditorStyles(state),
  );
  return state.actionBus.dispatchState(TAP_SELECT_WORD, state, {
    position,
    range: range ?? undefined,
  }).state;
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

describe("handles on part of an inline formula", () => {
  it("hangs both handles off the selected part", () => {
    const state = selectInside(load("$abcdefg$"), 2, 4);
    const handles = getTouchSelectionHandlePositions(state, viewport);

    expect(handles?.anchor?.isTop).toBe(true);
    expect(handles?.focus?.isTop).toBe(false);
    expect(handles!.focus!.x).toBeGreaterThan(handles!.anchor!.x);
  });

  it("treats a touch on the selected part as a touch on the selection", () => {
    const state = selectInside(load("$abcdefg$"), 2, 4);
    const handles = getTouchSelectionHandlePositions(state, viewport)!;
    const midX = (handles.anchor!.x + handles.focus!.x) / 2;
    const midY = handles.anchor!.y + handles.anchor!.height / 2;

    expect(isPointWithinSelectionRects(midX, midY, state, viewport)).toBe(true);
  });

  it("grows and shrinks the part as the end handle's ball is dragged", () => {
    const drag = grab(selectInside(load("$abcdefg$"), 2, 4), "focus");

    expect(insideRange(drag(24))).toEqual({ from: 2, to: 6 });
    expect(insideRange(drag(-10))).toEqual({ from: 2, to: 3 });
  });

  it("moves the start of the part with the start handle", () => {
    const drag = grab(selectInside(load("$abcdefg$"), 2, 4), "anchor");

    expect(insideRange(drag(-20))).toEqual({ from: 0, to: 4 });
    expect(insideRange(drag(10))).toEqual({ from: 3, to: 4 });
  });
});

describe("a handle that drifts off the formula's line", () => {
  // Paragraphs above and in front, so a point off the line has somewhere
  // else to land: the paragraph above, or the start of this line.
  const md = "above\n\nhi $abcdefg$ yo";

  function selectInsideSecond(from: number, to: number) {
    const state = moveCursorToPosition(load(md), 2, 1);
    const block = state.document.page.blocks[2];
    if (!isTextualBlock(block)) throw new Error("expected a textual block");
    const run = resolveStructuredInlineMathRuns(block)[0];
    if (!run?.contentId || !run.document) throw new Error("expected a chip");
    const a = mathContentSelectionFromSourceOffset(
      block.id,
      run.contentId,
      run.document,
      from,
    );
    const f = mathContentSelectionFromSourceOffset(
      block.id,
      run.contentId,
      run.document,
      to,
    );
    if (!a || !f) throw new Error("expected nested carets");
    const selected = updateContentSelection(state, {
      anchor: a.anchor,
      focus: f.focus,
      lastUpdate: 0,
    });
    return {
      state: selected,
      range: (s: EditorState) =>
        s.document.contentSelection
          ? mathSourceRangeFromContentSelection(
              run.document!,
              s.document.contentSelection,
            )
          : null,
    };
  }

  for (const which of ["anchor", "focus"] as const) {
    it(`keeps the part when the ${which} handle wobbles up and down`, () => {
      const { state, range } = selectInsideSecond(2, 4);
      const drag = grab(state, which);

      for (const dy of [-4, -8, -10, 4, 8, 10, 0]) {
        expect(range(drag(0, dy))).toEqual({ from: 2, to: 4 });
      }
    });

    it(`still follows the ${which} handle sideways while it wobbles`, () => {
      const { state, range } = selectInsideSecond(2, 4);
      const drag = grab(state, which);

      expect(range(drag(which === "focus" ? 24 : -20, -8))).toEqual(
        which === "focus" ? { from: 2, to: 6 } : { from: 0, to: 4 },
      );
    });
  }

  it("leaves the formula when the handle moves clearly to the line above", () => {
    const { state } = selectInsideSecond(2, 4);
    const drag = grab(state, "focus");

    const moved = drag(0, -60);
    expect(moved.document.contentSelection).toBeNull();
    expect(moved.document.selection?.focus.blockIndex).toBeLessThan(2);
  });

  it("leaves the formula sideways onto the same line, even a little high", () => {
    const { state } = selectInsideSecond(2, 4);
    const drag = grab(state, "focus");

    const moved = drag(80, -8);
    expect(moved.document.contentSelection).toBeNull();
    expect(moved.document.selection).toMatchObject({
      anchor: { blockIndex: 2, textIndex: 3 },
      focus: { blockIndex: 2 },
    });
    expect(moved.document.selection!.focus.textIndex).toBeGreaterThan(4);
  });
});

describe("dragging a handle into a wholly selected formula", () => {
  const md = "hi $a+b+c+d$ yo";

  it("starts from the whole formula as one flat selection", () => {
    const state = doubleTapFormula(load(md), 60);

    expect(state.document.contentSelection).toBeNull();
    expect(state.document.selection).toMatchObject({
      anchor: { textIndex: 3 },
      focus: { textIndex: 4 },
    });
  });

  it("keeps the whole formula until the handle actually drops part of it", () => {
    const drag = grab(doubleTapFormula(load(md), 60), "focus");

    const state = drag(-2);
    expect(state.document.contentSelection).toBeNull();
    expect(state.document.selection).toMatchObject({
      anchor: { textIndex: 3 },
      focus: { textIndex: 4 },
    });
  });

  it("drops the end of the formula when the end handle moves in", () => {
    const drag = grab(doubleTapFormula(load(md), 60), "focus");

    const state = drag(-32);
    expect(state.document.selection).toBeNull();
    expect(insideRange(state)).toEqual({ from: 0, to: 5 });
  });

  it("drops the start of the formula when the start handle moves in", () => {
    const drag = grab(doubleTapFormula(load(md), 60), "anchor");

    const state = drag(16);
    expect(state.document.selection).toBeNull();
    expect(insideRange(state)).toEqual({ from: 1, to: 7 });
  });

  it("goes back to a flat selection when the handle leaves the formula", () => {
    const drag = grab(doubleTapFormula(load(md), 60), "focus");

    drag(-32);
    const state = drag(20);
    expect(state.document.contentSelection).toBeNull();
    expect(state.document.selection).toMatchObject({
      anchor: { textIndex: 3 },
      focus: { textIndex: 5 },
    });
  });

  it("keeps the end fixed when the start handle crosses it and leaves the formula", () => {
    const drag = grab(doubleTapFormula(load(md), 60), "anchor");

    drag(16);
    drag(80);
    const state = drag(160);
    expect(state.document.contentSelection).toBeNull();
    // The end of the formula (4) stays the fixed end; the held handle is past
    // it, so the formula itself is no longer selected.
    expect(state.document.selection!.anchor.textIndex).toBe(4);
    expect(state.document.selection!.focus.textIndex).toBeGreaterThan(4);
  });

  it("keeps the end fixed when the start handle crosses it and goes down a line", () => {
    const drag = grab(
      doubleTapFormula(load(`${md}\n\nnext line`), 60),
      "anchor",
    );

    drag(16);
    drag(40);
    const state = drag(40, 40);
    expect(state.document.contentSelection).toBeNull();
    expect(state.document.selection!.anchor).toMatchObject({
      blockIndex: 0,
      textIndex: 4,
    });
    expect(state.document.selection!.focus.blockIndex).toBe(1);
  });

  it("keeps the start fixed when the end handle crosses it and leaves the formula", () => {
    const drag = grab(doubleTapFormula(load(md), 60), "focus");

    drag(-16);
    drag(-40);
    const state = drag(-200);
    expect(state.document.contentSelection).toBeNull();
    expect(state.document.selection!.anchor.textIndex).toBe(3);
    expect(state.document.selection!.focus.textIndex).toBeLessThan(3);
  });

  it("keeps the formula atomic for a selection that starts outside it", () => {
    let state = doubleTapFormula(load(md), 60);
    state = {
      ...state,
      document: {
        ...state.document,
        selection: {
          ...state.document.selection!,
          anchor: { blockIndex: 0, textIndex: 0 },
        },
      },
    };
    const drag = grab(state, "focus");

    const moved = drag(-32);
    expect(moved.document.contentSelection).toBeNull();
    expect(moved.document.selection).not.toBeNull();
  });

  it("does not move the selection when a handle is only touched", () => {
    for (const which of ["anchor", "focus"] as const) {
      const drag = grab(doubleTapFormula(load(md), 60), which);
      const state = drag(1, 1);
      // Grabbing the start handle swaps the ends; the span stays the same.
      const { anchor, focus } = state.document.selection!;
      expect(state.document.contentSelection).toBeNull();
      expect([anchor.textIndex, focus.textIndex].sort()).toEqual([3, 4]);
    }
  });
});

describe("a handle that leaves a formula and comes back", () => {
  // `a+b+c+d` is source 0..7; the part held fixed is around `b+` (2..4).
  const md = "hi $a+b+c+d$ yo\n\nnext line";

  /** Where a handle stands at a source offset inside the formula. */
  function xAt(offset: number) {
    return getTouchSelectionHandlePositions(
      selectInside(load(md), 0, offset),
      viewport,
    )!.focus!.x;
  }

  it("keeps the other end where it was after a trip to the line below", () => {
    const start = selectInside(load(md), 2, 4);
    const ball = ballOf(start, "anchor").x;
    const drag = grab(start, "anchor");

    // Across the fixed end, down to the next line, then back in before it.
    expect(insideRange(drag(xAt(6) - ball))).toEqual({ from: 4, to: 6 });
    expect(drag(xAt(6) - ball, 40).document.contentSelection).toBeNull();
    const state = drag(xAt(1) - ball);
    expect(state.document.selection).toBeNull();
    expect(insideRange(state)).toEqual({ from: 1, to: 4 });
  });

  it("keeps the other end where it was after a trip onto the text beside it", () => {
    const start = selectInside(load(md), 2, 4);
    const ball = ballOf(start, "focus").x;
    const drag = grab(start, "focus");

    expect(drag(xAt(7) + 40 - ball).document.contentSelection).toBeNull();
    const state = drag(xAt(6) - ball);
    expect(state.document.selection).toBeNull();
    expect(insideRange(state)).toEqual({ from: 2, to: 6 });
  });

  it("forgets that end once the finger lifts", () => {
    const start = selectInside(load(md), 2, 4);
    const ball = ballOf(start, "focus").x;
    const drag = grab(start, "focus");

    drag(xAt(7) + 40 - ball);
    const lifted = drag.release();
    expect(lifted.ui.selectionHandleDrag).toBeNull();
    expect(lifted.document.contentSelection).toBeNull();
  });
});

describe("a handle crossing a root inside a formula", () => {
  // `r(y)=` is source 0..5; the root `\sqrt{a^2-y^2}` is 5..27.
  const md = "$r(y)=\\sqrt{a^2-y^2}i+yj$";
  const crossingOf = (state: EditorState) =>
    state.ui.selectionHandleDrag?.crossing ?? null;

  /** The root's two edges, read off the crossing while the finger is on it. */
  function rootEdges() {
    const drag = grab(selectInside(load(md), 0, 1), "focus");
    let state = load(md);
    for (let dx = 0; dx < 200 && !crossingOf(state); dx += 4) state = drag(dx);
    const crossing = crossingOf(state);
    if (!crossing) throw new Error("expected the handle to cross the root");
    const ball = ballOf(selectInside(load(md), 0, 1), "focus");
    // The far edge: where the range lands once the root counts.
    const far = getTouchSelectionHandlePositions(
      selectInside(load(md), 0, 27),
      viewport,
    )!.focus!.x;
    return { near: crossing.nearX, far, ball: ball.x };
  }

  it("follows the finger into the root and leaves the root out before its middle", () => {
    const { near, far, ball } = rootEdges();
    const drag = grab(selectInside(load(md), 0, 1), "focus");

    const state = drag(near + (far - near) / 4 - ball);
    expect(crossingOf(state)).toMatchObject({ counted: false });
    expect(crossingOf(state)!.x).toBeCloseTo(near + (far - near) / 4, 0);
    expect(insideRange(state)).toEqual({ from: 0, to: 5 });
  });

  it("takes the whole root past its middle, with one tick", () => {
    const { near, far, ball } = rootEdges();
    const start = selectInside(load(md), 0, 1);
    const drag = grab(start, "focus");
    drag(near + (far - near) / 4 - ball);
    let ticks = 0;
    start.actionBus.register(CURSOR_DRAG_BOUNDARY, () => {
      ticks += 1;
    });

    const state = drag(near + ((far - near) * 3) / 4 - ball);
    expect(crossingOf(state)).toMatchObject({ counted: true });
    expect(insideRange(state)).toEqual({ from: 0, to: 27 });
    expect(ticks).toBe(1);
  });

  it("lets go of the root again when the finger goes back past its middle", () => {
    const { near, far } = rootEdges();
    const start = selectInside(load(md), 0, 31);
    const ball = ballOf(start, "focus").x;
    const drag = grab(start, "focus");

    drag(near + ((far - near) * 3) / 4 - ball);
    expect(insideRange(drag(near + ((far - near) * 3) / 4 - ball))?.to).toBe(
      27,
    );
    const state = drag(near + (far - near) / 4 - ball);
    expect(crossingOf(state)).toMatchObject({ counted: false });
    expect(insideRange(state)?.to).toBe(5);
  });

  it("stops tracking once the finger is past the root", () => {
    const { near, far, ball } = rootEdges();
    const drag = grab(selectInside(load(md), 0, 1), "focus");

    drag(near + (far - near) / 2 - ball);
    const state = drag(far + 12 - ball);
    expect(crossingOf(state)).toBeNull();
    expect(insideRange(state)!.to).toBeGreaterThan(27);
  });

  it("drops the crossing when the finger lifts", () => {
    const { near, far, ball } = rootEdges();
    const drag = grab(selectInside(load(md), 0, 1), "focus");

    drag(near + (far - near) / 4 - ball);
    expect(drag.release().ui.selectionHandleDrag).toBeNull();
  });
});

describe("a handle on a formula that makes its line taller", () => {
  // The nested fraction pushes the line's baseline down, so the top row (`ab`)
  // sits above where the flat caret beside the formula starts.
  const md = "$\\frac{\\frac{ab}{c}}{d}$";

  it("reaches the top row from the row below it", () => {
    // Source: `\\frac{\\frac{` 0..12, `a` 12, `b` 13, `}{` 14..16, `c` 16,
    // `}` 17; the inner fraction is 6..18.
    const start = selectInside(load(md), 16, 17);
    const top = getTouchSelectionHandlePositions(
      selectInside(load(md), 12, 13),
      viewport,
    )!.focus!;
    const from = getTouchSelectionHandlePositions(start, viewport)!.focus!;
    const drag = grab(start, "focus");

    // The finger goes up from `c` to `b`'s row: the range now spans both
    // rows of the inner fraction, so it takes that fraction whole.
    const state = drag(top.x - from.x, top.y - from.y);
    expect(insideRange(state)).toEqual({ from: 6, to: 18 });
  });
});

describe("dragging a handle into a whole formula over a root at its edge", () => {
  const crossingOf = (state: EditorState) =>
    state.ui.selectionHandleDrag?.crossing ?? null;

  /** Drag in step by step until the formula opens up into a part. */
  function dragUntilInside(
    drag: (dx: number) => EditorState,
    step: number,
  ): EditorState {
    let state = drag(0);
    for (let dx = step; Math.abs(dx) < 120; dx += step) {
      state = drag(dx);
      if (state.document.contentSelection) return state;
    }
    throw new Error("expected the formula to open up");
  }

  it("drops the root at the end before the finger is past its middle", () => {
    // `a+` is source 0..2; the root `\sqrt{b}` is 2..10.
    const drag = grab(
      doubleTapFormula(load("hi $a+\\sqrt{b}$ yo"), 60),
      "focus",
    );

    const state = dragUntilInside(drag, -1);
    expect(crossingOf(state)).toMatchObject({ counted: false });
    expect(insideRange(state)).toEqual({ from: 0, to: 2 });
  });

  it("drops the root at the start before the finger is past its middle", () => {
    // The root `\sqrt{b}` is source 0..8; `+a` is 8..10.
    const drag = grab(
      doubleTapFormula(load("hi $\\sqrt{b}+a$ yo"), 60),
      "anchor",
    );

    const state = dragUntilInside(drag, 1);
    expect(crossingOf(state)).toMatchObject({ counted: false });
    expect(insideRange(state)).toEqual({ from: 8, to: 10 });
  });
});

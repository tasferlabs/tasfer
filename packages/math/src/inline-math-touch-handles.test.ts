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

/**
 * A collaborator working inside a table.
 *
 * Remote presence is not a table concept: a peer's caret and selection arrive
 * as generic decorations (`presence:<peerId>`), addressed by the same
 * identity-bearing content points the local caret uses. Two seams have to hold
 * for that to show on a grid:
 *
 *   - the CARET is drawn centrally by the renderer, which used to gate every
 *     caret decoration on `isTextualBlock` — true for prose, false for a table,
 *     whose text all lives in its structured attachment. A peer typing in a
 *     cell was therefore invisible;
 *   - the SELECTION is painted by the node, and `TableNode` painted only the
 *     local one — so a peer's range over cells left no band at all, whether
 *     they were inside the grid, sweeping across it, or holding it whole.
 *
 * These tests pin both, in the peer's own color so a band cannot be confused
 * with the local selection's.
 */

import { tableCaretToContentPoint } from "./selection";
import { getTableDocument } from "./structured";
import { tableExtension } from "./table-extension";
import { type TableBlock, TableNode } from "./TableNode";
import { createNodeRegistry } from "@tasfer/editor";
import type { InteractionSession } from "@tasfer/editor/events/interaction-session";
import type { Decoration } from "@tasfer/editor/rendering/decorations";
import { setDecorationLayer } from "@tasfer/editor/rendering/decorations";
import {
  renderBlock,
  renderCursorLayer,
} from "@tasfer/editor/rendering/renderer";
import { baseSchema } from "@tasfer/editor/schema";
import { loadPage } from "@tasfer/editor/serlization/loadPage";
import type { EditorState, ViewportState } from "@tasfer/editor/state-types";
import { createInitialState } from "@tasfer/editor/state-utils";
import type { ContentPoint } from "@tasfer/editor/structured-selection";
import { resolveTheme } from "@tasfer/editor/styles";
import { describe, expect, it } from "vitest";

const schema = baseSchema.use(tableExtension());
const styles = resolveTheme({});
const node = new TableNode();
const MAX_WIDTH = 600;
const REMOTE = "#ff00aa";
const PEER_LAYER = "presence:peer-2";

/** A table with a paragraph after it, so a sweep can cross the grid. */
const SOURCE = [
  "| Fruit | Price |",
  "| --- | --- |",
  "| Apples | 1.20 |",
  "| Pears | 2.40 |",
  "",
  "After the table",
].join("\n");

const viewport: ViewportState = {
  width: MAX_WIDTH + styles.canvas.paddingLeft + styles.canvas.paddingRight,
  height: 800,
  scrollY: 0,
} as ViewportState;

function stateOf(): EditorState {
  return createInitialState(loadPage(SOURCE, schema.data), {
    schema: schema.data,
    nodes: createNodeRegistry(schema.nodes),
  });
}

function layoutOf(state: EditorState) {
  return node.layout({
    block: state.document.page.blocks[0],
    blockIndex: 0,
    maxWidth: MAX_WIDTH,
    isFirst: true,
    styles,
    marks: state.marks,
  });
}

/** A point in the cell at row-major index `at`, `offset` characters in. */
function pointAt(state: EditorState, at: number, offset: number): ContentPoint {
  const block = state.document.page.blocks[0];
  const document = getTableDocument(block)!;
  const cellId = layoutOf(state).cells[at].cellId!;
  return tableCaretToContentPoint(document, block.id, { cellId, offset })!;
}

function withPeer(state: EditorState, decorations: Decoration[]): EditorState {
  return {
    ...state,
    ui: {
      ...state.ui,
      decorations: setDecorationLayer(
        state.ui.decorations,
        PEER_LAYER,
        decorations,
      ),
    },
  };
}

interface Painted {
  name: string;
  args: number[];
  style: string;
  alpha: number;
}

/** A context that records every paint call with the style/alpha in force. */
function recordingCtx(): {
  ctx: CanvasRenderingContext2D;
  calls: Painted[];
} {
  const calls: Painted[] = [];
  let style = "";
  let alpha = 1;
  const record =
    (name: string) =>
    (...args: number[]) =>
      calls.push({ name, args, style, alpha });
  const ctx = {
    canvas: {},
    measureText: (text: string) => ({ width: (text?.length ?? 0) * 7 }),
    save() {},
    restore() {},
    translate() {},
    scale() {},
    setTransform() {},
    clearRect() {},
    clip() {},
    beginPath() {},
    closePath() {},
    moveTo() {},
    lineTo() {},
    arc() {},
    quadraticCurveTo() {},
    stroke() {},
    fillText() {},
    strokeText() {},
    drawImage() {},
    roundRect: record("roundRect"),
    fillRect: record("fillRect"),
    fill: record("fill"),
    set font(_v: string) {},
    set fillStyle(v: string) {
      style = v;
    },
    set strokeStyle(_v: string) {},
    set lineWidth(_v: number) {},
    set textBaseline(_v: string) {},
    set textAlign(_v: string) {},
    set direction(_v: string) {},
    set globalAlpha(v: number) {
      alpha = v;
    },
    get globalAlpha() {
      return alpha;
    },
  } as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

/** Paint the table block at the origin and return what the peer's color drew. */
function peerPaints(state: EditorState): Painted[] {
  const { ctx, calls } = recordingCtx();
  renderBlock(
    ctx,
    state,
    state.document.page.blocks[0],
    0,
    true,
    0,
    0,
    MAX_WIDTH,
    styles,
  );
  return calls.filter((call) => call.style === REMOTE);
}

/** Paint the cursor layer and return what the peer's color drew. */
function peerCarets(state: EditorState): Painted[] {
  const { ctx, calls } = recordingCtx();
  const session = {
    outOfViewIndicatorHitAreas: [],
  } as unknown as InteractionSession;
  renderCursorLayer(ctx, session, state, viewport, styles);
  return calls.filter(
    (call) => call.style === REMOTE && call.name === "fillRect",
  );
}

describe("a peer's caret in a cell", () => {
  it("paints where the cell places it, not at the block's edge", () => {
    const state = stateOf();
    const point = pointAt(state, 2, 3);
    const painted = peerCarets(
      withPeer(state, [
        { kind: "caret", point, color: REMOTE, label: { text: "Sam" } },
      ]),
    );

    const rect = node.contentCaretRect(layoutOf(state), point, {
      state,
      // The persisted `Block` union has no table member; the node narrows it.
      block: state.document.page.blocks[0] as unknown as TableBlock,
      blockIndex: 0,
      maxWidth: MAX_WIDTH,
      isFirst: true,
      styles,
      marks: state.marks,
      origin: { x: styles.canvas.paddingLeft, y: styles.canvas.paddingTop },
    })!;

    const caret = painted.find(
      (call) => call.args[2] === styles.remoteCursor.caretWidth,
    );
    expect(caret).toBeDefined();
    expect(caret!.args[0]).toBe(rect.x);
    expect(caret!.args[1]).toBe(rect.y);
  });

  it("draws nothing for a peer whose point is in another block", () => {
    const state = stateOf();
    const point = {
      ...(pointAt(state, 2, 3) as ContentPoint),
      blockId: state.document.page.blocks[1].id,
    } as ContentPoint;

    expect(
      peerCarets(withPeer(state, [{ kind: "caret", point, color: REMOTE }])),
    ).toHaveLength(0);
  });
});

/**
 * A band is filled through the shared decoration painter, which rounds the
 * corners only when the theme asks for a radius — `roundRect` then, a plain
 * `fillRect` otherwise. Both take `(x, y, width, height, …)`.
 */
function isBandFill(call: { name: string }): boolean {
  return call.name === "roundRect" || call.name === "fillRect";
}

describe("a peer's selection in a table", () => {
  it("bands the characters a peer covers inside one cell", () => {
    const state = stateOf();
    const painted = peerPaints(
      withPeer(state, [
        {
          kind: "range",
          range: { from: pointAt(state, 2, 0), to: pointAt(state, 2, 3) },
          color: REMOTE,
        },
      ]),
    );

    const cell = layoutOf(state).cells[2];
    const band = painted.find(isBandFill);
    expect(band).toBeDefined();
    // Part of the cell, not the whole of it: three characters of "Apples".
    expect(band!.args[2]).toBeGreaterThan(0);
    expect(band!.args[2]).toBeLessThan(cell.width);
  });

  it("covers every cell a peer's range spans, whole", () => {
    const state = stateOf();
    const painted = peerPaints(
      withPeer(state, [
        {
          kind: "range",
          range: { from: pointAt(state, 2, 1), to: pointAt(state, 4, 2) },
          color: REMOTE,
        },
      ]),
    );

    const layout = layoutOf(state);
    const bands = painted.filter(isBandFill);
    // Cells 2..4 of the grid, each filled edge to edge.
    expect(bands).toHaveLength(3);
    for (const [index, band] of bands.entries()) {
      const cell = layout.cells[2 + index];
      // The radius trails the rect; the band itself is the cell, edge to edge.
      expect(band.args.slice(0, 4)).toEqual([
        cell.x,
        cell.y,
        cell.width,
        cell.height,
      ]);
    }
  });

  it("washes the grid when a peer holds the table whole", () => {
    const state = stateOf();
    const painted = peerPaints(
      withPeer(state, [
        {
          kind: "block",
          block: state.document.page.blocks[0].id,
          color: REMOTE,
        },
      ]),
    );

    const layout = layoutOf(state);
    expect(
      painted.some(
        (call) =>
          call.name === "fillRect" &&
          call.args[1] === layout.gridTop &&
          call.args[2] === layout.gridWidth &&
          call.args[3] === layout.gridHeight,
      ),
    ).toBe(true);
  });

  it("washes the grid when a peer's sweep crosses the table", () => {
    const state = stateOf();
    const blocks = state.document.page.blocks;
    const painted = peerPaints(
      withPeer(state, [
        {
          kind: "range",
          range: {
            from: { block: blocks[0].id, offset: 0 },
            to: { block: blocks[1].id, offset: 5 },
          },
          color: REMOTE,
        },
      ]),
    );

    const layout = layoutOf(state);
    expect(
      painted.some(
        (call) =>
          call.name === "fillRect" && call.args[3] === layout.gridHeight,
      ),
    ).toBe(true);
  });

  it("leaves the table alone for a sweep that never reaches it", () => {
    const state = stateOf();
    const blocks = state.document.page.blocks;
    const painted = peerPaints(
      withPeer(state, [
        {
          kind: "range",
          range: {
            from: { block: blocks[1].id, offset: 0 },
            to: { block: blocks[1].id, offset: 5 },
          },
          color: REMOTE,
        },
      ]),
    );

    expect(painted).toHaveLength(0);
  });

  it("paints nothing in the peer's color with no presence at all", () => {
    expect(peerPaints(stateOf())).toHaveLength(0);
  });
});

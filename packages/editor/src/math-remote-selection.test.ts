/**
 * A remote peer's selection over a BLOCK equation must paint, like it does over
 * every other block. Peer selections are generic range decorations on a
 * `presence:<peerId>` layer; `TextNode`/`AtomicNode` paint them, but `MathNode`
 * overrides `paint` and used to draw only the LOCAL selection — so a peer's
 * highlight vanished on math blocks while their caret (drawn centrally by the
 * renderer, node-independently) still showed. This paints an equation with a
 * range decoration and asserts the highlight fill is emitted, with a rest control
 * and a local-selection sanity check.
 */
import {
  createMathTestState,
  createMathTestSyncEngine,
} from "./__testutils__/math";
import { setDecorationLayer } from "./rendering/decorations";
import { renderBlock } from "./rendering/renderer";
import { updateSelection } from "./selection";
import type { EditorState } from "./state-types";
import { getEditorStyles } from "./styles";
import { insertCharsAtPosition } from "./sync/crdt-utils";
import { createCRDTbinding } from "./sync/sync";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  const g = globalThis as unknown as {
    document: { createElement: () => unknown };
  };
  const ctx = {
    measureText: (t: string) => ({
      width: (t?.length ?? 0) * 9,
      fontBoundingBoxAscent: 12,
      fontBoundingBoxDescent: 4,
    }),
    setTransform() {},
    save() {},
    restore() {},
    translate() {},
    scale() {},
    fillText() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    roundRect() {},
    fill() {},
    fillRect() {},
  };
  g.document.createElement = () => ({
    getContext: () => ctx,
    style: {},
    setAttribute() {},
    appendChild() {},
    width: 1,
    height: 1,
  });
});

/** A recording context that captures every filled rectangle with its style/alpha. */
function recordingCtx(): {
  ctx: CanvasRenderingContext2D;
  fills: { alpha: number; style: string }[];
} {
  const fills: { alpha: number; style: string }[] = [];
  let alpha = 1;
  let style = "";
  const push = () => fills.push({ alpha, style });
  const ctx = {
    measureText: (t: string) => ({ width: (t?.length ?? 0) * 9 }),
    save() {},
    restore() {},
    translate() {},
    scale() {},
    fillText() {},
    strokeText() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    roundRect() {},
    fill() {
      push();
    },
    fillRect() {
      push();
    },
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
  return { ctx, fills };
}

function paintFirstBlock(state: EditorState) {
  const { ctx, fills } = recordingCtx();
  const styles = getEditorStyles(state);
  renderBlock(
    ctx,
    state,
    state.document.page.blocks[0],
    0,
    true,
    0,
    0,
    600,
    styles,
  );
  return fills;
}

function blockEquation(latex: string) {
  const binding = createCRDTbinding("remote-sel", "peer-1");
  const engine = createMathTestSyncEngine(binding);
  const blockOp = engine.createBlockInsert(null, "math", { displayMode: true });
  engine.emit([blockOp]);
  const page = insertCharsAtPosition(
    engine.getState(),
    blockOp.blockId,
    0,
    latex,
    binding,
  ).newPage;
  return {
    state: createMathTestState(page, { crdtBinding: binding }),
    blockId: blockOp.blockId,
  };
}

const REMOTE = "#ff00aa";

/** Put a peer selection over `[from, to)` of the equation on a presence layer. */
function withRemoteSelection(
  state: EditorState,
  blockId: string,
  from: number,
  to: number,
): EditorState {
  const decorations = setDecorationLayer(
    state.ui.decorations,
    "presence:peer-2",
    [
      {
        kind: "range",
        range: {
          from: { block: blockId, offset: from },
          to: { block: blockId, offset: to },
        },
        color: REMOTE,
        opacity: 0.3,
      },
    ],
  );
  return { ...state, ui: { ...state.ui, decorations } };
}

describe("block equation — remote peer selection highlight", () => {
  it("paints the peer's selection fill in the peer's color", () => {
    const { state, blockId } = blockEquation("x+y=2");
    const fills = paintFirstBlock(withRemoteSelection(state, blockId, 1, 4));
    // The highlight is filled with the decoration's own color (not the local
    // selection color), which no other fill in the equation uses.
    expect(fills.some((f) => f.style === REMOTE)).toBe(true);
  });

  it("draws no such fill at rest (control)", () => {
    const { state } = blockEquation("x+y=2");
    const fills = paintFirstBlock(state);
    expect(fills.some((f) => f.style === REMOTE)).toBe(false);
  });

  it("still paints the LOCAL selection too (sanity)", () => {
    const { state } = blockEquation("x+y=2");
    const selected = updateSelection(state, {
      anchor: { blockIndex: 0, textIndex: 1 },
      focus: { blockIndex: 0, textIndex: 4 },
    });
    const styles = getEditorStyles(selected);
    const fills = paintFirstBlock(selected);
    expect(
      fills.some((f) => f.style === styles.selection.backgroundColor),
    ).toBe(true);
  });
});

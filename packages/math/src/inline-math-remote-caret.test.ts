/**
 * A collaborator's caret inside an inline formula.
 *
 * A peer's caret arrives as a generic `presence:<peerId>` caret decoration
 * addressed by the same content point the local caret uses. The renderer gated
 * every such decoration on the *node* declaring nested caret geometry — right
 * for a table, whose cells belong to `TableNode`, but blind to inline math,
 * which is a replacement MARK on an ordinary paragraph. The peer's caret was
 * dropped before the geometry that would have placed it ever ran, so a
 * collaborator editing a formula left no caret at all — while their selection
 * highlight, painted by a different seam, showed fine (see
 * `math-remote-selection.test.ts`).
 *
 * These pin the caret: that it paints at all, that it tracks the offset inside
 * the formula rather than snapping to the chip's edge, and that a peer pointing
 * at another block still draws nothing.
 */
import { resolveStructuredInlineMathRuns } from "./inline-structured";
import { mathExtension } from "./math-extension";
import { mathContentSelectionFromSourceOffset } from "./tree-selection";
import { createNodeRegistry } from "@tasfer/editor";
import type { InteractionSession } from "@tasfer/editor/events/interaction-session";
import { setDecorationLayer } from "@tasfer/editor/rendering/decorations";
import { createMarkRegistry } from "@tasfer/editor/rendering/marks";
import { renderCursorLayer } from "@tasfer/editor/rendering/renderer";
import { baseSchema } from "@tasfer/editor/schema";
import { loadPage } from "@tasfer/editor/serlization/loadPage";
import type { EditorState, ViewportState } from "@tasfer/editor/state-types";
import { createInitialState } from "@tasfer/editor/state-utils";
import type { ContentPoint } from "@tasfer/editor/structured-selection";
import { resolveTheme } from "@tasfer/editor/styles";
import { isTextualBlock } from "@tasfer/editor/sync/block-registry";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  // The tex engine measures through an offscreen canvas; give it one.
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

const schema = baseSchema.use(mathExtension());
const styles = resolveTheme({});
const MAX_WIDTH = 600;
const REMOTE = "#ff00aa";
const PEER_LAYER = "presence:peer-2";

const viewport: ViewportState = {
  width: MAX_WIDTH + styles.canvas.paddingLeft + styles.canvas.paddingRight,
  height: 800,
  scrollY: 0,
} as ViewportState;

/** A context that records every filled rectangle with the style in force. */
function recordingCtx() {
  const calls: { name: string; args: number[]; style: string }[] = [];
  let style = "";
  const record =
    (name: string) =>
    (...args: number[]) =>
      calls.push({ name, args, style });
  const ctx = {
    canvas: {},
    measureText: (t: string) => ({ width: (t?.length ?? 0) * 9 }),
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
    set globalAlpha(_v: number) {},
    get globalAlpha() {
      return 1;
    },
  } as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

/** A paragraph with an inline formula in the middle of it. */
function inlineEquation() {
  const state = createInitialState(
    loadPage("before $x+y$ after", schema.data),
    {
      schema: schema.data,
      nodes: createNodeRegistry(schema.nodes),
      marks: createMarkRegistry(schema.marks),
    },
  );
  const block = state.document.page.blocks[0];
  if (!isTextualBlock(block)) throw new Error("expected textual host block");
  const run = resolveStructuredInlineMathRuns(block)[0];
  if (!run?.document || !run.contentId) {
    throw new Error("expected structured inline math");
  }
  return { state, block, document: run.document, contentId: run.contentId };
}

/** A point `offset` characters into the formula's source. */
function pointAt(offset: number): { state: EditorState; point: ContentPoint } {
  const { state, block, document, contentId } = inlineEquation();
  const at = mathContentSelectionFromSourceOffset(
    block.id,
    contentId,
    document,
    offset,
  );
  if (!at) throw new Error("expected a structured point");
  return { state, point: at.focus };
}

function withPeerCaret(state: EditorState, point: ContentPoint): EditorState {
  const decorations = setDecorationLayer(state.ui.decorations, PEER_LAYER, [
    { kind: "caret", point, color: REMOTE, label: { text: "Sam" } },
  ]);
  return { ...state, ui: { ...state.ui, decorations } };
}

/** The caret bar the peer's colour drew, if any. */
function peerCaret(state: EditorState) {
  const { ctx, calls } = recordingCtx();
  const session = {
    outOfViewIndicatorHitAreas: [],
  } as unknown as InteractionSession;
  renderCursorLayer(ctx, session, state, viewport, styles);
  return calls.find(
    (call) =>
      call.style === REMOTE &&
      call.name === "fillRect" &&
      call.args[2] === styles.remoteCursor.caretWidth,
  );
}

describe("a peer's caret inside an inline formula", () => {
  it("paints, though the host block's node owns no nested geometry", () => {
    const { state, point } = pointAt(2);

    expect(peerCaret(withPeerCaret(state, point))).toBeDefined();
  });

  it("tracks the offset inside the formula", () => {
    const start = pointAt(0);
    const later = pointAt(2);

    const atStart = peerCaret(withPeerCaret(start.state, start.point));
    const atLater = peerCaret(withPeerCaret(later.state, later.point));

    expect(atStart).toBeDefined();
    expect(atLater).toBeDefined();
    // Two characters in, not pinned to the chip's leading edge.
    expect(atLater!.args[0]).toBeGreaterThan(atStart!.args[0]);
  });

  it("draws nothing for a peer whose point is in another block", () => {
    const { state, point } = pointAt(2);
    const elsewhere = { ...point, blockId: "no-such-block" } as ContentPoint;

    expect(peerCaret(withPeerCaret(state, elsewhere))).toBeUndefined();
  });
});

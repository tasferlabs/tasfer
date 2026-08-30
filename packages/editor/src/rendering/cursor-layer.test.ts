/**
 * The cursor layer's nested-caret seam.
 *
 * Core resolves a caret two ways: by index into a block's flat text, and — for
 * a block whose text lives in a structured attachment — by asking the owning
 * node through `contentCaretRect`. The geometry side of that seam was complete
 * while both cursor paths still gated on `isTextualBlock`, so a caret in a
 * table cell had a correct position that nothing ever drew and no viewport
 * coordinates to anchor against.
 *
 * These tests pin the gate itself, with a stub node rather than a real table:
 * what lets a block past is that its node declares nested caret geometry, never
 * that core recognizes the block's type.
 */

import type {
  IndicatorHitArea,
  InteractionSession,
} from "../events/interaction-session";
import type { Block } from "../serlization/loadPage";
import type { EditorState, EditorStyles, ViewportState } from "../state-types";
import type { ContentPoint, ContentSelection } from "../structured-selection";
import { defaultStyles } from "../styles";
import { BlockHeightIndex } from "./block-height-index";
import type { DecorationLayers } from "./decorations";
import { MarkRegistry } from "./marks";
import { AtomicNode } from "./nodes/AtomicNode";
import type { NodeCaretRect } from "./nodes/Node";
import { NodeRegistry } from "./nodes/Node";
import { getIndexedCursorViewportCoords, renderCursorLayer } from "./renderer";
import { describe, expect, it } from "vitest";

const BLOCK_HEIGHT = 100;
/** The rect the stub node claims for every point it is asked about. */
const STUB_RECT = { x: 40, y: 12, height: 15 } as const;

/** A non-textual block whose node places the caret inside its own content. */
class NestedCaretNode extends AtomicNode {
  readonly type = "nested-caret" as const;
  protected intrinsicHeight(): number {
    return BLOCK_HEIGHT;
  }
  protected draw(): void {}
  contentCaretRect(
    _layout: unknown,
    _point: ContentPoint,
    c: { origin: { x: number; y: number } },
  ): NodeCaretRect | null {
    return {
      x: c.origin.x + STUB_RECT.x,
      y: c.origin.y + STUB_RECT.y,
      height: STUB_RECT.height,
    };
  }
}

/** The same block shape with no nested caret geometry declared. */
class PlainAtomicNode extends AtomicNode {
  readonly type = "plain-atomic" as const;
  protected intrinsicHeight(): number {
    return BLOCK_HEIGHT;
  }
  protected draw(): void {}
}

function blockOf(type: string, id: string, originalIndex: number) {
  return { type, id, originalIndex } as unknown as Block & {
    originalIndex: number;
  };
}

function pointIn(blockId: string, afterCharId: string | null): ContentPoint {
  return {
    kind: "text",
    blockId,
    contentId: `${blockId}:content`,
    nodeId: "cell-1",
    field: "text",
    afterCharId,
  } as unknown as ContentPoint;
}

function selectionIn(
  blockId: string,
  focusAfterCharId: string | null = null,
): ContentSelection {
  return {
    anchor: pointIn(blockId, null),
    focus: pointIn(blockId, focusAfterCharId),
    // Recent, so the blink clock reports the caret solid.
    lastUpdate: Date.now(),
  } as unknown as ContentSelection;
}

function stateWith(
  node: AtomicNode,
  contentSelection: ContentSelection | null,
  opts: { deleted?: boolean; decorations?: DecorationLayers } = {},
): EditorState {
  const block = blockOf(node.type, "b1", 0);
  if (opts.deleted) (block as unknown as { deleted: boolean }).deleted = true;
  return {
    nodes: new NodeRegistry().register(node),
    marks: new MarkRegistry(),
    document: {
      page: { blocks: [block] },
      cursor: null,
      selection: null,
      contentSelection,
    },
    view: { visibleBlocks: [block], isFocused: true },
    ui: {
      mode: "edit",
      isReadonlyBase: false,
      composition: null,
      decorations: opts.decorations ?? {},
    },
  } as unknown as EditorState;
}

/** A peer's caret at `point`, on its own presence layer. */
function peerCaretLayer(point: ContentPoint): DecorationLayers {
  return {
    "presence:peer-2": [
      { kind: "caret", point, color: "#ff00aa", label: { text: "Sam" } },
    ],
  };
}

const viewport: ViewportState = {
  width: 500,
  height: 1000,
  scrollY: 0,
  documentHeight: 0,
};
const styles: EditorStyles = defaultStyles;
const session = {} as InteractionSession;

/** A 2D context that records the calls the caret paint makes. */
function recordingCtx() {
  const calls: { name: string; args: unknown[] }[] = [];
  const ctx = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === "canvas") return { width: 500, height: 1000 };
        if (prop === "measureText") return () => ({ width: 10 });
        return (...args: unknown[]) => {
          calls.push({ name: prop, args });
        };
      },
      set() {
        return true;
      },
    },
  ) as unknown as CanvasRenderingContext2D;
  return {
    ctx,
    calls,
    named: (name: string) => calls.filter((c) => c.name === name),
    /** Anything that puts pixels down for the caret bar. */
    fills: () =>
      calls.filter((c) => c.name === "fillRect" || c.name === "fill").length,
  };
}

function heightIndexFor(state: EditorState) {
  const index = new BlockHeightIndex();
  index.rebuild(state.view.visibleBlocks, () => BLOCK_HEIGHT);
  return index;
}

describe("cursor layer — a caret the node owns", () => {
  it("paints a caret for a non-textual block whose node places one", () => {
    const state = stateWith(new NestedCaretNode(), selectionIn("b1"));
    const rec = recordingCtx();

    renderCursorLayer(rec.ctx, session, state, viewport, styles);

    expect(rec.fills()).toBeGreaterThan(0);
  });

  it("draws nothing when the node declares no nested caret geometry", () => {
    const state = stateWith(new PlainAtomicNode(), selectionIn("b1"));
    const rec = recordingCtx();

    renderCursorLayer(rec.ctx, session, state, viewport, styles);

    expect(rec.fills()).toBe(0);
  });

  it("draws no caret while a nested range is active", () => {
    // Anchor and focus in different places: a range, not a caret. Keeps a
    // range-selected table from showing a caret as well as its highlight.
    const state = stateWith(new NestedCaretNode(), selectionIn("b1", "char-9"));
    const rec = recordingCtx();

    renderCursorLayer(rec.ctx, session, state, viewport, styles);

    expect(rec.fills()).toBe(0);
  });

  it("balances save/restore when the caret's block is deleted", () => {
    const state = stateWith(new NestedCaretNode(), selectionIn("b1"), {
      deleted: true,
    });
    const rec = recordingCtx();

    renderCursorLayer(rec.ctx, session, state, viewport, styles);

    expect(rec.named("restore").length).toBe(rec.named("save").length);
  });

  it("resolves viewport coordinates for a nested caret", () => {
    const state = stateWith(new NestedCaretNode(), selectionIn("b1"));

    const coords = getIndexedCursorViewportCoords(
      { blockIndex: 0, textIndex: 0 },
      state,
      viewport,
      styles,
      heightIndexFor(state),
    );

    expect(coords).not.toBeNull();
    expect(coords!.height).toBe(STUB_RECT.height);
    expect(coords!.x).toBe(styles.canvas.paddingLeft + STUB_RECT.x);
  });

  it("resolves no coordinates for a non-textual block with no nested caret", () => {
    const state = stateWith(new PlainAtomicNode(), selectionIn("b1"));

    expect(
      getIndexedCursorViewportCoords(
        { blockIndex: 0, textIndex: 0 },
        state,
        viewport,
        styles,
        heightIndexFor(state),
      ),
    ).toBeNull();
  });

  it("resolves no coordinates when the content selection is in another block", () => {
    const state = stateWith(new NestedCaretNode(), selectionIn("other-block"));

    expect(
      getIndexedCursorViewportCoords(
        { blockIndex: 0, textIndex: 0 },
        state,
        viewport,
        styles,
        heightIndexFor(state),
      ),
    ).toBeNull();
  });
});

/**
 * A remote peer's caret in the same kind of block. It arrives as a decoration
 * rather than as the local selection, and used to be dropped before geometry
 * was ever asked for: the collector required a block with flat text, which a
 * table (all of whose text is in its structured attachment) is not.
 */
describe("cursor layer — a peer's caret the node owns", () => {
  const peerPoint = pointIn("b1", "char-4");

  /** A session with the indicator scratch array every peer paint writes into. */
  function peerSession(hitAreas: IndicatorHitArea[] = []): InteractionSession {
    return {
      outOfViewIndicatorHitAreas: hitAreas,
    } as unknown as InteractionSession;
  }

  it("paints a peer's caret in a block that has no flat text", () => {
    const state = stateWith(new NestedCaretNode(), null, {
      decorations: peerCaretLayer(peerPoint),
    });
    const rec = recordingCtx();

    renderCursorLayer(rec.ctx, peerSession(), state, viewport, styles);

    const caret = rec
      .named("fillRect")
      .find((call) => call.args[0] === styles.canvas.paddingLeft + STUB_RECT.x);
    expect(caret).toBeDefined();
  });

  it("draws nothing for a peer whose node declares no nested caret geometry", () => {
    const state = stateWith(new PlainAtomicNode(), null, {
      decorations: peerCaretLayer(peerPoint),
    });
    const rec = recordingCtx();

    renderCursorLayer(rec.ctx, peerSession(), state, viewport, styles);

    expect(rec.fills()).toBe(0);
  });

  it("carries the peer's nested address on the out-of-view indicator", () => {
    // A viewport too short to hold the block: the peer is off-screen, so the
    // gutter pill stands in for their caret. Tapping it has to reach a cell,
    // which the flat blockIndex/textIndex pair cannot express on its own.
    const state = stateWith(new NestedCaretNode(), null, {
      decorations: peerCaretLayer(peerPoint),
    });
    const hitAreas: IndicatorHitArea[] = [];
    const rec = recordingCtx();

    renderCursorLayer(
      rec.ctx,
      peerSession(hitAreas),
      state,
      { ...viewport, height: 5 },
      styles,
    );

    expect(hitAreas).toHaveLength(1);
    expect(hitAreas[0].contentPoint).toEqual(peerPoint);
  });
});

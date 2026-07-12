import { insertText } from "../actions/actions";
import { createChromeRegionRegistry } from "../events/chromeRegions";
import {
  createInteractionSession,
  type InteractionSession,
  type TouchState,
} from "../events/interaction-session";
import { handleMouseDown, handleMouseMove } from "../events/mouseEvents";
import { handleTouchEnd, handleTouchMove } from "../events/touchEvents";
import { mathExtension } from "../math-extension";
import { MathNode } from "../nodes/MathNode";
import { createMarkRegistry } from "../rendering/marks";
import { createNodeRegistry } from "../rendering/nodes";
import type { NodeLayout } from "../rendering/nodes/Node";
import { baseSchema } from "../schema";
import { getContentSelectionFromViewport } from "../selection";
import { loadPage } from "../serlization/loadPage";
import type {
  EditorState,
  MouseEvent,
  ViewportState,
  VisibleBlockRange,
} from "../state-types";
import { createInitialState } from "../state-utils";
import {
  resolveContentTextPointOffset,
  updateContentSelection,
} from "../structured-selection";
import { getEditorStyles } from "../styles";
import {
  getMathStructuredDocument,
  mathContentIdForBlock,
  parseLegacyMathDocumentInit,
  structuredToMathDocument,
} from "./structured";
import type {
  MathDocumentCaretPosition,
  MathDocumentLayout,
} from "@cypherkit/tex";
import { mathDocumentCaretStop } from "@cypherkit/tex";
import { describe, expect, it } from "vitest";

const schema = baseSchema.use(mathExtension({ displayEditing: "tree" }));
const viewport: ViewportState = {
  width: 800,
  height: 600,
  scrollY: 0,
  documentHeight: 600,
};

interface TestMathLayout extends NodeLayout {
  readonly mathDocumentLayout: MathDocumentLayout;
  readonly mathOffsetX: number;
  readonly mathTop: number;
}

interface MathGeometry {
  readonly state: EditorState;
  readonly node: MathNode;
  readonly layout: TestMathLayout;
  readonly blockTop: number;
  readonly originX: number;
}

function treeMathState(latex: string): EditorState {
  const page = loadPage(`$$\n${latex}\n$$`, schema.data);
  const block = page.blocks[0];
  const contentId = mathContentIdForBlock(block.id);
  const init = parseLegacyMathDocumentInit(latex, { contentId });
  const treeBlock = {
    ...block,
    charRuns: [],
    structuredContent: { [contentId]: init.document },
  };
  return createInitialState(
    { ...page, blocks: [treeBlock] },
    {
      schema: schema.data,
      nodes: createNodeRegistry(schema.nodes),
      marks: createMarkRegistry(schema.marks),
    },
  );
}

function legacyMathState(latex: string): EditorState {
  const page = loadPage(`$$\n${latex}\n$$`, schema.data);
  return createInitialState(page, {
    schema: schema.data,
    nodes: createNodeRegistry(schema.nodes),
    marks: createMarkRegistry(schema.marks),
  });
}

function geometry(state: EditorState): MathGeometry {
  const styles = getEditorStyles(state);
  const block = state.document.page.blocks[0];
  const node = state.nodes.get("math");
  if (!(node instanceof MathNode)) throw new Error("expected MathNode");
  const maxWidth =
    viewport.width - styles.canvas.paddingLeft - styles.canvas.paddingRight;
  const layout = node.layout({
    block,
    blockIndex: 0,
    maxWidth,
    isFirst: true,
    styles,
    marks: state.marks,
  }) as TestMathLayout;
  return {
    state,
    node,
    layout,
    blockTop: styles.canvas.paddingTop,
    originX: styles.canvas.paddingLeft,
  };
}

function pointForPosition(
  value: MathGeometry,
  position: MathDocumentCaretPosition,
): { x: number; y: number } {
  const stop = mathDocumentCaretStop(value.layout.mathDocumentLayout, position);
  if (!stop) throw new Error("expected a stable caret stop");
  return {
    x: value.originX + value.layout.mathOffsetX + stop.x,
    y:
      value.blockTop +
      value.layout.mathTop +
      value.layout.mathDocumentLayout.height +
      stop.y,
  };
}

function hit(
  value: MathGeometry,
  point: { x: number; y: number },
  pointerType: "mouse" | "touch" = "mouse",
) {
  return getContentSelectionFromViewport(
    point.x,
    point.y,
    value.state,
    viewport,
    pointerType,
  );
}

function visibility(value: MathGeometry): VisibleBlockRange {
  return { start: 0, end: 0, startY: value.blockTop };
}

function tapAt(x: number, y: number): TouchState {
  return {
    startY: y,
    startScrollY: 0,
    lastY: y,
    lastTime: Date.now(),
    velocityY: 0,
    velocityHistory: [],
    startX: x,
    startTime: Date.now(),
    isLongPress: false,
    hasMoved: false,
    currentTouchX: x,
    currentTouchY: y,
    isTouchingSelection: false,
    isTouchingCursor: false,
    isCursorDrag: false,
    touchRadiusX: 8,
    touchRadiusY: 8,
  };
}

function touchEnd(
  value: MathGeometry,
  point: { x: number; y: number },
  session: InteractionSession,
): EditorState {
  session.touch = tapAt(point.x, point.y);
  return handleTouchEnd(
    value.state,
    viewport,
    { changedTouches: [] } as unknown as TouchEvent,
    { left: 0, top: 0 },
    viewport.documentHeight,
    session,
    undefined,
    undefined,
    visibility(value),
  ).state;
}

describe("structured display-math hit testing", () => {
  it("lands directly in the numerator and denominator raw-text fields", () => {
    const value = geometry(treeMathState(String.raw`\frac{ab}{cd}`));
    const document = getMathStructuredDocument(
      value.state.document.page.blocks[0],
    );
    const math = document ? structuredToMathDocument(document) : undefined;
    const fraction = math?.root.body.children[0];
    if (!document || !fraction || fraction.type !== "fraction") {
      throw new Error("expected a structured fraction");
    }
    const numerator = fraction.numerator.children[0];
    const denominator = fraction.denominator.children[0];
    if (
      !numerator ||
      numerator.type !== "raw-text" ||
      !denominator ||
      denominator.type !== "raw-text"
    ) {
      throw new Error("expected editable fraction fields");
    }

    const numeratorHit = hit(
      value,
      pointForPosition(value, {
        kind: "field",
        rowId: fraction.numerator.id,
        nodeId: numerator.id,
        field: "text",
        offset: 1,
      }),
    );
    const denominatorHit = hit(
      value,
      pointForPosition(value, {
        kind: "field",
        rowId: fraction.denominator.id,
        nodeId: denominator.id,
        field: "text",
        offset: 1,
      }),
    );

    expect(numeratorHit?.focus).toMatchObject({
      kind: "text",
      nodeId: numerator.id,
      field: "text",
    });
    expect(denominatorHit?.focus).toMatchObject({
      kind: "text",
      nodeId: denominator.id,
      field: "text",
    });
    expect(
      numeratorHit?.focus.kind === "text"
        ? resolveContentTextPointOffset(
            value.state.document.page,
            numeratorHit.focus,
          )
        : null,
    ).toBe(1);
    expect(
      denominatorHit?.focus.kind === "text"
        ? resolveContentTextPointOffset(
            value.state.document.page,
            denominatorHit.focus,
          )
        : null,
    ).toBe(1);
    expect(numeratorHit?.focus).not.toEqual(denominatorHit?.focus);
  });

  it("makes both empty fraction slots direct structural caret targets", () => {
    const value = geometry(treeMathState(String.raw`\frac{}{}`));
    const document = getMathStructuredDocument(
      value.state.document.page.blocks[0],
    );
    const math = document ? structuredToMathDocument(document) : undefined;
    const fraction = math?.root.body.children[0];
    if (!fraction || fraction.type !== "fraction") {
      throw new Error("expected a structured fraction");
    }

    const numeratorHit = hit(
      value,
      pointForPosition(value, {
        kind: "row",
        rowId: fraction.numerator.id,
        offset: 0,
      }),
      "touch",
    );
    const denominatorHit = hit(
      value,
      pointForPosition(value, {
        kind: "row",
        rowId: fraction.denominator.id,
        offset: 0,
      }),
      "touch",
    );

    expect(numeratorHit?.focus).toMatchObject({
      kind: "gap",
      parentId: fraction.numerator.id,
      afterNodeId: null,
    });
    expect(denominatorHit?.focus).toMatchObject({
      kind: "gap",
      parentId: fraction.denominator.id,
      afterNodeId: null,
    });
  });

  it("keeps a completely empty authoritative equation clickable", () => {
    const value = geometry(treeMathState(""));
    const document = getMathStructuredDocument(
      value.state.document.page.blocks[0],
    );
    const math = document ? structuredToMathDocument(document) : undefined;
    if (!math) throw new Error("expected an empty math document");
    const selection = hit(
      value,
      pointForPosition(value, {
        kind: "row",
        rowId: math.root.body.id,
        offset: 0,
      }),
    );

    expect(selection?.focus).toMatchObject({
      kind: "gap",
      parentId: math.root.body.id,
      afterNodeId: null,
    });
    expect(value.layout.mathOffsetX).toBeGreaterThan(0);
  });

  it("falls back from an unsupported semantic field to an editable row gap", () => {
    const value = geometry(treeMathState(String.raw`\operatorname{lim}`));
    const document = getMathStructuredDocument(
      value.state.document.page.blocks[0],
    );
    const math = document ? structuredToMathDocument(document) : undefined;
    const operator = math?.root.body.children[0];
    if (!operator || operator.type !== "operator") {
      throw new Error("expected an operator node");
    }
    const item = value.layout.mathDocumentLayout.items.get(operator.id);
    if (!item) throw new Error("expected operator geometry");
    const point = {
      x:
        value.originX +
        value.layout.mathOffsetX +
        item.bounds.x +
        item.bounds.width / 2,
      y:
        value.blockTop +
        value.layout.mathTop +
        value.layout.mathDocumentLayout.height +
        item.baseline,
    };

    const selection = hit(value, point);
    expect(selection?.focus).toMatchObject({
      kind: "gap",
      parentId: math.root.body.id,
    });

    const inserted = insertText(
      updateContentSelection(value.state, selection),
      "x",
    );
    expect(inserted.ops).toContainEqual(
      expect.objectContaining({ op: "content_edit" }),
    );
  });

  it("keeps legacy display math on its flat source-cursor path", () => {
    const value = geometry(legacyMathState("ab"));
    const point = {
      x: value.originX + value.layout.mathOffsetX,
      y: value.blockTop + value.layout.mathTop,
    };
    expect(hit(value, point)).toBeNull();
  });

  it("a desktop click installs the nested caret without a flat bridge", () => {
    const value = geometry(treeMathState("ab"));
    const document = getMathStructuredDocument(
      value.state.document.page.blocks[0],
    );
    const math = document ? structuredToMathDocument(document) : undefined;
    const text = math?.root.body.children[0];
    if (!text || text.type !== "raw-text") throw new Error("expected text");
    const point = pointForPosition(value, {
      kind: "field",
      rowId: math.root.body.id,
      nodeId: text.id,
      field: "text",
      offset: 1,
    });
    const session = createInteractionSession(createChromeRegionRegistry());
    const next = handleMouseDown(
      value.state,
      viewport,
      {
        button: 0,
        x: point.x,
        y: point.y,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
      } as MouseEvent,
      { left: 0, top: 0 },
      viewport.documentHeight,
      session,
      visibility(value),
    ).state;

    expect(next.document.cursor).toBeNull();
    expect(next.document.selection).toBeNull();
    expect(next.document.contentSelection?.focus).toMatchObject({
      kind: "text",
      nodeId: text.id,
    });
    const focus = next.document.contentSelection?.focus;
    expect(
      focus?.kind === "text"
        ? resolveContentTextPointOffset(next.document.page, focus)
        : null,
    ).toBe(1);
  });

  it("desktop drag extends the stable content range without demoting it", () => {
    const value = geometry(treeMathState("abc"));
    const document = getMathStructuredDocument(
      value.state.document.page.blocks[0],
    );
    const math = document ? structuredToMathDocument(document) : undefined;
    const text = math?.root.body.children[0];
    if (!text || text.type !== "raw-text") throw new Error("expected text");
    const start = pointForPosition(value, {
      kind: "field",
      rowId: math.root.body.id,
      nodeId: text.id,
      field: "text",
      offset: 0,
    });
    const end = pointForPosition(value, {
      kind: "field",
      rowId: math.root.body.id,
      nodeId: text.id,
      field: "text",
      offset: 2,
    });
    const session = createInteractionSession(createChromeRegionRegistry());
    const down = handleMouseDown(
      value.state,
      viewport,
      {
        button: 0,
        x: start.x,
        y: start.y,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
      } as MouseEvent,
      { left: 0, top: 0 },
      viewport.documentHeight,
      session,
      visibility(value),
    ).state;
    const next = handleMouseMove(
      down,
      viewport,
      {
        x: end.x,
        y: end.y,
        ctrlKey: false,
        metaKey: false,
      } as MouseEvent,
      { left: 0, top: 0 },
      viewport.documentHeight,
      session,
      visibility(value),
    );

    expect(next.document.cursor).toBeNull();
    const range = next.document.contentSelection;
    expect(range?.anchor.kind).toBe("text");
    expect(range?.focus.kind).toBe("text");
    expect(
      range?.focus.kind === "text"
        ? resolveContentTextPointOffset(next.document.page, range.focus)
        : null,
    ).toBe(2);
  });

  it("a touch tap installs the same stable caret and caret geometry", () => {
    const value = geometry(treeMathState(String.raw`\frac{a}{b}`));
    const document = getMathStructuredDocument(
      value.state.document.page.blocks[0],
    );
    const math = document ? structuredToMathDocument(document) : undefined;
    const fraction = math?.root.body.children[0];
    if (!fraction || fraction.type !== "fraction") {
      throw new Error("expected fraction");
    }
    const denominator = fraction.denominator.children[0];
    if (!denominator || denominator.type !== "raw-text") {
      throw new Error("expected denominator text");
    }
    const denominatorPosition = {
      kind: "field",
      rowId: fraction.denominator.id,
      nodeId: denominator.id,
      field: "text",
      offset: 1,
    } as const satisfies MathDocumentCaretPosition;
    const denominatorStop = mathDocumentCaretStop(
      value.layout.mathDocumentLayout,
      denominatorPosition,
    );
    if (!denominatorStop) throw new Error("expected denominator caret stop");
    const point = pointForPosition(value, denominatorPosition);
    const session = createInteractionSession(createChromeRegionRegistry());
    const next = touchEnd(value, point, session);

    expect(next.document.cursor).toBeNull();
    expect(next.document.selection).toBeNull();
    expect(next.document.contentSelection?.focus).toMatchObject({
      kind: "text",
      nodeId: denominator.id,
    });
    const focus = next.document.contentSelection?.focus;
    expect(
      focus?.kind === "text"
        ? resolveContentTextPointOffset(next.document.page, focus)
        : null,
    ).toBe(1);

    const caret = value.node.caretRect(
      value.layout,
      0,
      value.originX,
      value.blockTop,
      next,
      next.document.page.blocks[0].id,
    );
    expect(caret.x).toBeCloseTo(point.x, 3);
    expect(caret.y).toBeCloseTo(
      value.blockTop +
        value.layout.mathTop +
        value.layout.mathDocumentLayout.height +
        denominatorStop.top,
      3,
    );
    expect(caret.height).toBeCloseTo(
      denominatorStop.bottom - denominatorStop.top,
      3,
    );
  });

  it("touch magnifier drag keeps the caret in structured identity space", () => {
    const value = geometry(treeMathState("abc"));
    const document = getMathStructuredDocument(
      value.state.document.page.blocks[0],
    );
    const math = document ? structuredToMathDocument(document) : undefined;
    const text = math?.root.body.children[0];
    if (!text || text.type !== "raw-text") throw new Error("expected text");
    const start = pointForPosition(value, {
      kind: "field",
      rowId: math.root.body.id,
      nodeId: text.id,
      field: "text",
      offset: 0,
    });
    const end = pointForPosition(value, {
      kind: "field",
      rowId: math.root.body.id,
      nodeId: text.id,
      field: "text",
      offset: 2,
    });
    const initialSelection = hit(value, start, "touch");
    if (!initialSelection) throw new Error("expected initial content caret");
    const state = updateContentSelection(value.state, initialSelection);
    const session = createInteractionSession(createChromeRegionRegistry());
    session.touch = {
      ...tapAt(start.x, start.y),
      lastTime: Date.now() - 16,
      isTouchingCursor: true,
      isCursorDrag: true,
    };
    const next = handleTouchMove(
      state,
      viewport,
      {
        preventDefault() {},
        touches: [
          {
            clientX: end.x,
            clientY: end.y,
            radiusX: 8,
            radiusY: 8,
          },
        ],
      } as unknown as TouchEvent,
      { left: 0, top: 0 },
      viewport.documentHeight,
      session,
      undefined,
      visibility(value),
    );

    expect(next.document.cursor).toBeNull();
    const focus = next.document.contentSelection?.focus;
    expect(
      focus?.kind === "text"
        ? resolveContentTextPointOffset(next.document.page, focus)
        : null,
    ).toBe(2);
  });
});

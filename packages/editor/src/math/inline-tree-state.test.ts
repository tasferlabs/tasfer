import { insertText } from "../actions/actions";
import {
  buildClipboardPayload,
  pasteFromClipboardEvent,
} from "../actions/clipboard";
import {
  DELETE_BACKWARD,
  DELETE_FORWARD,
  SPLIT_BLOCK,
} from "../actions/edit-actions";
import {
  COMPOSITION_END,
  COMPOSITION_START,
  CUT,
} from "../actions/input-actions";
import {
  EXTEND_SELECTION_DOWN,
  EXTEND_SELECTION_LEFT,
  EXTEND_SELECTION_RIGHT,
  MOVE_CONTENT_TAB,
  MOVE_CURSOR_DOWN,
  MOVE_CURSOR_LEFT,
  MOVE_CURSOR_RIGHT,
  MOVE_CURSOR_UP,
} from "../actions/keyboard-actions";
import { TEXT_CLICK } from "../actions/pointer-actions";
import { createFeatureMarkInRange } from "../actions/structured-marks";
import { resolveMarkRuns } from "../inline-math-spans";
import { mathExtension } from "../math-extension";
import type { TextNode, TextNodeLayout } from "../nodes/TextNode";
import { createMarkRegistry } from "../rendering/marks";
import { createNodeRegistry } from "../rendering/nodes";
import { baseSchema } from "../schema";
import { moveCursorToPosition, updateSelection } from "../selection";
import { loadPage } from "../serlization/loadPage";
import { serializeToMarkdown } from "../serlization/serializer";
import type { ContentEdit, EditorState } from "../state-types";
import { createInitialState } from "../state-utils";
import { updateContentSelection } from "../structured-selection";
import { getEditorStyles } from "../styles";
import { isTextualBlock } from "../sync/block-registry";
import { getVisibleTextFromRuns } from "../sync/char-runs";
import { recordUndoOps, undoState } from "../sync/crdt-undo";
import {
  applyStructuredEdits,
  type StructuredEdit,
} from "../sync/structured-content";
import { createCRDTbinding } from "../sync/sync";
import { INSERT_MATH_COMMAND, RESIZE_MATH_MATRIX } from "./actions";
import {
  getInlineMathStructuredDocument,
  getStructuredMathMarkSource,
} from "./inline-structured";
import {
  deleteActiveInlineMathTree,
  enterInlineMathTreeAtPosition,
} from "./inline-tree-state";
import { structuredToMathDocument } from "./structured";
import { mathContentSelectionFromSourceOffset } from "./tree-selection";
import { printMathDocument } from "@cypherkit/tex/data";
import { describe, expect, it } from "vitest";

const inlineTreeSchema = baseSchema.use(mathExtension());
const legacyInlineSchema = baseSchema.use(mathExtension());

function legacyChip(peer = "inline-test", markdown = "$x$"): EditorState {
  const binding = createCRDTbinding("page", peer);
  let state = createInitialState(loadPage(markdown, inlineTreeSchema.data), {
    schema: inlineTreeSchema.data,
    nodes: createNodeRegistry(inlineTreeSchema.nodes),
    marks: createMarkRegistry(inlineTreeSchema.marks),
    crdtBinding: binding,
  });
  state = moveCursorToPosition(state, 0, 1);
  return state;
}

function peerAttachedLegacyState(): EditorState {
  const binding = createCRDTbinding("page", "legacy-attached");
  let page = loadPage("axyb", legacyInlineSchema.data);
  page = createFeatureMarkInRange(
    page,
    page.blocks[0].id,
    1,
    3,
    { type: "math" },
    binding,
    legacyInlineSchema.data,
  ).newPage;
  return moveCursorToPosition(
    createInitialState(page, {
      schema: legacyInlineSchema.data,
      nodes: createNodeRegistry(legacyInlineSchema.nodes),
      marks: createMarkRegistry(legacyInlineSchema.marks),
      crdtBinding: binding,
    }),
    0,
    2,
  );
}

function compatibilitySource(state: EditorState): string {
  const block = state.document.page.blocks[0];
  return "charRuns" in block ? getVisibleTextFromRuns(block.charRuns) : "";
}

function canonicalSource(state: EditorState): string | undefined {
  const block = state.document.page.blocks[0];
  if (!("formats" in block)) return undefined;
  return getStructuredMathMarkSource(
    block.formats[0]?.format,
    block.structuredContent,
  );
}

function inlineMathDocument(state: EditorState) {
  const block = state.document.page.blocks[0];
  return "formats" in block
    ? getInlineMathStructuredDocument(
        block.formats[0]?.format,
        block.structuredContent,
      )
    : undefined;
}

function enter(state: EditorState, at = 1): EditorState {
  const entered = enterInlineMathTreeAtPosition(state, 0, at, {
    allowBoundary: true,
  });
  if (!entered) throw new Error("inline math did not enter tree mode");
  return entered.state;
}

function enterMathOffset(
  state: EditorState,
  sourceOffset: number,
): EditorState {
  const run = resolveMarkRuns(state.document.page.blocks[0]).find(
    (candidate) => candidate.name === "math",
  );
  if (!run) throw new Error("expected an inline math run");
  return enter(state, run.startIndex + sourceOffset);
}

describe("interactive structured MathMark", () => {
  it("extends an inline tree selection with Shift+Left and Shift+Right", () => {
    const before = enterMathOffset(legacyChip("inline-horizontal", "$ab$"), 2);
    const anchor = before.document.contentSelection?.focus;

    const left = before.actionBus.dispatchState(EXTEND_SELECTION_LEFT, before);
    expect(left.claimed).toBe(true);
    expect(left.state.document.contentSelection?.anchor).toEqual(anchor);
    expect(left.state.document.contentSelection?.focus).not.toEqual(anchor);

    const right = left.state.actionBus.dispatchState(
      EXTEND_SELECTION_RIGHT,
      left.state,
    );
    expect(right.claimed).toBe(true);
    expect(right.state.document.contentSelection?.anchor).toEqual(anchor);
    expect(right.state.document.contentSelection?.focus).toEqual(anchor);
  });

  it.each([
    ["left", 2, EXTEND_SELECTION_LEFT, MOVE_CURSOR_LEFT],
    ["right", 0, EXTEND_SELECTION_RIGHT, MOVE_CURSOR_RIGHT],
  ] as const)(
    "collapses a boundary-facing inline selection with Arrow%s",
    (_name, offset, extend, move) => {
      const before = enterMathOffset(
        legacyChip(`inline-collapse-${_name}`, "$ab$"),
        offset,
      );
      const first = before.actionBus.dispatchState(extend, before).state;
      const selected = first.actionBus.dispatchState(extend, first).state;
      expect(selected.document.contentSelection?.anchor).not.toEqual(
        selected.document.contentSelection?.focus,
      );

      const moved = selected.actionBus.dispatchState(move, selected);

      expect(moved.claimed).toBe(true);
      expect(moved.state.document.contentSelection?.anchor).toEqual(
        moved.state.document.contentSelection?.focus,
      );
    },
  );

  it("splits after the whole attached mark on Enter", () => {
    const before = enter(legacyChip("inline-enter", "$x$tail"));
    expect(before.document.cursor).toBeNull();

    const result = before.actionBus.dispatchState(SPLIT_BLOCK, before);

    expect(result.claimed).toBe(false);
    expect(result.state.document.page.blocks).toHaveLength(2);
    expect(
      serializeToMarkdown(result.state.document.page.blocks, undefined, {
        schema: result.state.schema,
      }),
    ).toBe("$x$\ntail");
    expect(result.state.document.contentSelection).toBeNull();
    expect(result.state.document.cursor?.position).toEqual({
      blockIndex: 1,
      textIndex: 0,
    });
    expect(canonicalSource(result.state)).toBe("x");
  });

  it.each([
    ["Backspace", DELETE_BACKWARD, 11],
    ["Delete", DELETE_FORWARD, 0],
  ] as const)(
    "%s selects an inline large construct before deleting it",
    (_label, action, offset) => {
      const source = String.raw`\frac{a}{b}`;
      const before = enterMathOffset(
        legacyChip(`inline-select-${offset}`, `$${source}$`),
        offset,
      );

      const selected = before.actionBus.dispatchState(action, before);
      expect(canonicalSource(selected.state)).toBe(source);
      expect(selected.state.document.contentSelection?.anchor).not.toEqual(
        selected.state.document.contentSelection?.focus,
      );

      const deleted = selected.state.actionBus.dispatchState(
        action,
        selected.state,
      );
      expect(canonicalSource(deleted.state)).toBe("");
    },
  );

  it("keeps peer-attached shadows atomic on a legacy client", () => {
    const before = peerAttachedLegacyState();
    const block = before.document.page.blocks[0];
    const contentId =
      "formats" in block
        ? (block.formats[0]?.format.attrs?.contentId as string | undefined)
        : undefined;
    const source = (state: EditorState) => {
      const current = state.document.page.blocks[0];
      return "formats" in current
        ? getStructuredMathMarkSource(
            current.formats[0]?.format,
            current.structuredContent,
          )
        : undefined;
    };
    expect(contentId).toBeTruthy();

    const inserted = insertText(before, "Q");
    expect(inserted.ops).toEqual([]);
    expect(compatibilitySource(inserted.state)).toBe("axyb");
    expect(source(inserted.state)).toBe("xy");

    const backward = before.actionBus.dispatchState(DELETE_BACKWARD, before);
    const forward = before.actionBus.dispatchState(DELETE_FORWARD, before);
    for (const deleted of [backward, forward]) {
      expect(deleted.claimed).toBe(true);
      expect(deleted.ops).toEqual([]);
      expect(compatibilitySource(deleted.state)).toBe("axyb");
      expect(source(deleted.state)).toBe("xy");
    }

    const selected = updateSelection(before, {
      anchor: { blockIndex: 0, textIndex: 0 },
      focus: { blockIndex: 0, textIndex: 3 },
    });
    const cut = selected.actionBus.dispatchState(CUT, selected);
    expect(cut.ops.length).toBeGreaterThan(0);
    expect(compatibilitySource(cut.state)).toBe("b");
    expect(source(cut.state)).toBe("xy");
  });

  it("expands mixed prose/math selections to whole attached formulas", () => {
    const before = peerAttachedLegacyState();
    const clippedTail = updateSelection(before, {
      anchor: { blockIndex: 0, textIndex: 2 },
      focus: { blockIndex: 0, textIndex: 4 },
    });
    expect(buildClipboardPayload(clippedTail)?.markdown).toBe("$xy$b");
    const cut = clippedTail.actionBus.dispatchState(CUT, clippedTail);
    expect(compatibilitySource(cut.state)).toBe("a");
    expect(cut.ops.length).toBeGreaterThan(0);

    const clippedHead = updateSelection(before, {
      anchor: { blockIndex: 0, textIndex: 0 },
      focus: { blockIndex: 0, textIndex: 2 },
    });
    const replaced = insertText(clippedHead, "Q");
    expect(compatibilitySource(replaced.state)).toBe("Qb");
    expect(replaced.ops.length).toBeGreaterThan(0);
    expect(
      serializeToMarkdown(replaced.state.document.page.blocks, undefined, {
        schema: replaced.state.schema,
      }),
    ).toBe("Qb");
  });

  it("defers atomic mixed-selection replacement until IME commit", () => {
    const selected = updateSelection(peerAttachedLegacyState(), {
      anchor: { blockIndex: 0, textIndex: 0 },
      focus: { blockIndex: 0, textIndex: 3 },
    });
    const started = selected.actionBus.dispatchState(
      COMPOSITION_START,
      selected,
      { data: "Q" },
    );
    expect(started.ops).toEqual([]);
    expect(compatibilitySource(started.state)).toBe("axyb");

    const committed = started.state.actionBus.dispatchState(
      COMPOSITION_END,
      started.state,
      { data: "Q" },
    );
    expect(committed.ops.length).toBeGreaterThan(0);
    expect(compatibilitySource(committed.state)).toBe("Qb");
  });

  it("keeps flat boundary typing outside an attached projection", () => {
    for (const [boundary, expectedText, expectedMarkdown] of [
      [1, "aQxyb", "aQ$xy$b"],
      [3, "axyQb", "a$xy$Qb"],
    ] as const) {
      const before = moveCursorToPosition(
        peerAttachedLegacyState(),
        0,
        boundary,
      );
      const beforeBlock = before.document.page.blocks[0];
      const contentId = resolveMarkRuns(beforeBlock).find(
        (run) => run.name === "math",
      )?.attrs.contentId;
      expect(typeof contentId).toBe("string");

      const inserted = insertText(before, "Q");
      const block = inserted.state.document.page.blocks[0];
      const attachedRun = resolveMarkRuns(block).find(
        (run) => run.attrs.contentId === contentId,
      );
      expect(compatibilitySource(inserted.state)).toBe(expectedText);
      expect(attachedRun?.text).toBe("xy");
      expect(
        typeof contentId === "string"
          ? getStructuredMathMarkSource(
              { type: "math", attrs: { contentId } },
              block.structuredContent,
            )
          : undefined,
      ).toBe("xy");
      expect(
        serializeToMarkdown(inserted.state.document.page.blocks, undefined, {
          schema: inserted.state.schema,
        }),
      ).toBe(expectedMarkdown);
    }
  });

  it("does not fuse a peer-attached projection with an adjacent legacy chip", () => {
    const binding = createCRDTbinding("page", "legacy-merge");
    let page = loadPage("$x$ $y$", legacyInlineSchema.data);
    page = createFeatureMarkInRange(
      page,
      page.blocks[0].id,
      0,
      1,
      { type: "math" },
      binding,
      legacyInlineSchema.data,
    ).newPage;
    const before = moveCursorToPosition(
      createInitialState(page, {
        schema: legacyInlineSchema.data,
        nodes: createNodeRegistry(legacyInlineSchema.nodes),
        marks: createMarkRegistry(legacyInlineSchema.marks),
        crdtBinding: binding,
      }),
      0,
      2,
    );
    const contentId = resolveMarkRuns(before.document.page.blocks[0]).find(
      (run) => run.attrs.contentId,
    )?.attrs.contentId;

    const deleted = before.actionBus.dispatchState(DELETE_BACKWARD, before);
    const block = deleted.state.document.page.blocks[0];
    expect(
      resolveMarkRuns(block).find((run) => run.attrs.contentId === contentId)
        ?.text,
    ).toBe("x");
    expect(
      serializeToMarkdown(deleted.state.document.page.blocks, undefined, {
        schema: deleted.state.schema,
      }),
    ).toBe("$x$$y$");
  });

  it("clones the attachment when native multi-block paste moves its mark", () => {
    const before = moveCursorToPosition(peerAttachedLegacyState(), 0, 1);
    const pasted = pasteFromClipboardEvent(before, {} as ClipboardEvent, {
      html: "",
      text: "first\nsecond",
      imageFile: null,
    });

    expect(pasted?.ops.length).toBeGreaterThan(0);
    expect(pasted?.state).not.toBe(before);
    expect(
      pasted &&
        serializeToMarkdown(pasted.state.document.page.blocks, undefined, {
          schema: pasted.state.schema,
        }),
    ).toBe("afirst\nsecond$xy$b");
    const tail = pasted?.state.document.page.blocks.find(
      (candidate) =>
        !candidate.deleted &&
        "charRuns" in candidate &&
        getVisibleTextFromRuns(candidate.charRuns) === "secondxyb",
    );
    const contentId = tail
      ? resolveMarkRuns(tail).find((run) => run.attrs.contentId)?.attrs
          .contentId
      : undefined;
    expect(typeof contentId).toBe("string");
    expect(contentId && tail?.structuredContent?.[contentId]).toBeDefined();
    expect(
      pasted?.ops.some(
        (op) =>
          op.op === "content_edit" &&
          op.blockId === tail?.id &&
          op.contentId === contentId &&
          op.edit.kind === "document_init",
      ),
    ).toBe(true);
  });

  it("allows multi-block paste when the mixed selection removes the attachment", () => {
    const before = updateSelection(peerAttachedLegacyState(), {
      anchor: { blockIndex: 0, textIndex: 0 },
      focus: { blockIndex: 0, textIndex: 2 },
    });
    const pasted = pasteFromClipboardEvent(before, {} as ClipboardEvent, {
      html: "",
      text: "first\nsecond",
      imageFile: null,
    });

    expect(pasted?.ops.length).toBeGreaterThan(0);
    expect(
      pasted &&
        serializeToMarkdown(pasted.state.document.page.blocks, undefined, {
          schema: pasted.state.schema,
        }),
    ).toBe("first\nsecondb");
  });

  it("does not claim an ambiguous flat boundary without a chip hit", () => {
    expect(enterInlineMathTreeAtPosition(legacyChip(), 0, 1)).toBeUndefined();
  });

  it("returns horizontal navigation to the host text at both tree edges", () => {
    const atEnd = enterMathOffset(legacyChip("inline-exit-right", "a$xy$b"), 2);
    const right = atEnd.actionBus.dispatchState(MOVE_CURSOR_RIGHT, atEnd);

    expect(right.claimed).toBe(true);
    expect(right.state.document.contentSelection).toBeNull();
    expect(right.state.document.cursor?.position).toEqual({
      blockIndex: 0,
      textIndex: 3,
    });

    const atStart = enterMathOffset(
      legacyChip("inline-exit-left", "a$xy$b"),
      0,
    );
    const left = atStart.actionBus.dispatchState(MOVE_CURSOR_LEFT, atStart);

    expect(left.claimed).toBe(true);
    expect(left.state.document.contentSelection).toBeNull();
    expect(left.state.document.cursor?.position).toEqual({
      blockIndex: 0,
      textIndex: 1,
    });
  });

  it("routes horizontal and slot navigation through the inline tree", () => {
    const entered = enter(legacyChip("inline-nav"));
    const end = entered.document.contentSelection?.focus;
    const left = entered.actionBus.dispatchState(MOVE_CURSOR_LEFT, entered);
    expect(left.claimed).toBe(true);
    expect(left.ops).toEqual([]);
    expect(left.state.document.contentSelection?.focus).not.toEqual(end);

    const right = left.state.actionBus.dispatchState(
      MOVE_CURSOR_RIGHT,
      left.state,
    );
    expect(right.claimed).toBe(true);
    expect(right.state.document.contentSelection?.focus).toEqual(end);

    const fraction = enterInlineMathTreeAtPosition(
      legacyChip("inline-tab", String.raw`$\frac{}{}$`),
      0,
      6,
      { allowBoundary: true },
    );
    expect(fraction).toBeDefined();
    if (!fraction) return;
    const beforeTab = fraction.state.document.contentSelection?.focus;
    const tabbed = fraction.state.actionBus.dispatchState(
      MOVE_CONTENT_TAB,
      fraction.state,
      { backward: false },
    );
    expect(tabbed.claimed).toBe(true);
    expect(tabbed.ops).toEqual([]);
    expect(tabbed.state.document.contentSelection?.focus).not.toEqual(
      beforeTab,
    );
    const shiftedBack = tabbed.state.actionBus.dispatchState(
      MOVE_CONTENT_TAB,
      tabbed.state,
      { backward: true },
    );
    expect(shiftedBack.state.document.contentSelection?.focus).toEqual(
      beforeTab,
    );

    const vertical = shiftedBack.state.actionBus.dispatchState(
      MOVE_CURSOR_DOWN,
      shiftedBack.state,
      {
        viewport: {
          width: 500,
          height: 300,
          scrollY: 0,
          documentHeight: 300,
        },
      },
    );
    expect(vertical.claimed).toBe(true);
    expect(vertical.ops).toEqual([]);
    expect(vertical.state.document.contentSelection).not.toEqual(
      shiftedBack.state.document.contentSelection,
    );
    const verticalBack = vertical.state.actionBus.dispatchState(
      MOVE_CURSOR_UP,
      vertical.state,
      {
        viewport: {
          width: 500,
          height: 300,
          scrollY: 0,
          documentHeight: 300,
        },
      },
    );
    expect(verticalBack.claimed).toBe(true);
    expect(verticalBack.state.document.contentSelection?.focus).toEqual(
      shiftedBack.state.document.contentSelection?.focus,
    );

    const extended = shiftedBack.state.actionBus.dispatchState(
      EXTEND_SELECTION_DOWN,
      shiftedBack.state,
      {
        viewport: {
          width: 500,
          height: 300,
          scrollY: 0,
          documentHeight: 300,
        },
      },
    );
    expect(extended.claimed).toBe(true);
    expect(extended.ops).toEqual([]);
    expect(extended.state.document.contentSelection?.anchor).toEqual(
      shiftedBack.state.document.contentSelection?.anchor,
    );
    expect(extended.state.document.contentSelection?.focus).toEqual(
      vertical.state.document.contentSelection?.focus,
    );
  });

  it("replaces a trailing inline command semantically and undoes it", () => {
    const entered = enter(legacyChip("inline-command"), 0);
    const cleared = deleteActiveInlineMathTree(entered, "forward");
    if (!cleared) throw new Error("expected inline tree deletion");
    let before = cleared.state;
    for (const char of String.raw`\sq`) before = insertText(before, char).state;
    expect(canonicalSource(before)).toBe(String.raw`\sq`);
    const inserted = before.actionBus.dispatchState(
      INSERT_MATH_COMMAND,
      before,
      { text: String.raw`\sqrt{}`, caretOffset: 6 },
    );

    expect(inserted.claimed).toBe(true);
    expect(inserted.ops.length).toBeGreaterThan(0);
    expect(inserted.ops.every((op) => op.op === "content_edit")).toBe(true);
    expect(compatibilitySource(inserted.state)).toBe("x");
    expect(canonicalSource(inserted.state)).toBe(String.raw`\sqrt{}`);
    const document = inlineMathDocument(inserted.state)!;
    const math = structuredToMathDocument(document);
    expect(
      math?.root.body.children.some((node) => node.type === "radical"),
    ).toBe(true);
    expect(
      Object.values(document.nodes).some(
        (node) =>
          node.type === "raw-text" &&
          getVisibleTextFromRuns(node.textFields.text).includes("sqrt"),
      ),
    ).toBe(false);

    const recorded = recordUndoOps(
      before,
      inserted.state,
      inserted.ops,
      before.CRDTbinding.getPeerId(),
    );
    expect(canonicalSource(undoState(recorded).state)).toBe(String.raw`\sq`);
  });

  it("resizes an inline matrix through tree edits and undoes it", () => {
    const latex = String.raw`\begin{bmatrix}a&b\\c&d\end{bmatrix}`;
    const before = enterInlineMathTreeAtPosition(
      legacyChip("inline-matrix", `$${latex}$`),
      0,
      latex.indexOf("a") + 1,
      { allowBoundary: true },
    );
    expect(before).toBeDefined();
    if (!before) return;

    const resized = before.state.actionBus.dispatchState(
      RESIZE_MATH_MATRIX,
      before.state,
      { rows: 3, cols: 3 },
    );
    expect(resized.claimed).toBe(true);
    expect(resized.ops.length).toBeGreaterThan(0);
    expect(compatibilitySource(resized.state)).toBe(latex);
    const resizedMath = structuredToMathDocument(
      inlineMathDocument(resized.state)!,
    );
    const matrix = resizedMath?.root.body.children.find(
      (node) => node.type === "matrix",
    );
    expect(matrix?.type).toBe("matrix");
    if (matrix?.type !== "matrix") return;
    expect(matrix.rows).toHaveLength(3);
    expect(matrix.rows.every((row) => row.cells.length === 3)).toBe(true);

    const recorded = recordUndoOps(
      before.state,
      resized.state,
      resized.ops,
      before.state.CRDTbinding.getPeerId(),
    );
    const undoneMath = structuredToMathDocument(
      inlineMathDocument(undoState(recorded).state)!,
    );
    const undoneMatrix = undoneMath?.root.body.children.find(
      (node) => node.type === "matrix",
    );
    expect(undoneMatrix?.type).toBe("matrix");
    if (undoneMatrix?.type !== "matrix") return;
    expect(undoneMatrix.rows).toHaveLength(2);
    expect(undoneMatrix.rows.every((row) => row.cells.length === 2)).toBe(true);
  });

  it("resizes a whole selected inline matrix from its opening endpoint", () => {
    const latex = String.raw`\frac{a}{b}\begin{bmatrix}a&b\\c&d\end{bmatrix}`;
    const before = enterInlineMathTreeAtPosition(
      legacyChip("inline-selected-matrix", `$${latex}$`),
      0,
      latex.indexOf("a&b"),
      { allowBoundary: true },
    );
    expect(before).toBeDefined();
    if (!before) return;
    const document = inlineMathDocument(before.state);
    if (!document) throw new Error("expected structured inline matrix");
    const point = before.state.document.contentSelection?.focus;
    if (!point) throw new Error("expected inline matrix caret");
    const anchor = mathContentSelectionFromSourceOffset(
      point.blockId,
      point.contentId,
      document,
      latex.indexOf("\\begin"),
    );
    const focus = mathContentSelectionFromSourceOffset(
      point.blockId,
      point.contentId,
      document,
      latex.length,
    );
    if (!anchor || !focus) throw new Error("expected matrix boundary range");
    const selected = updateContentSelection(before.state, {
      anchor: anchor.focus,
      focus: focus.focus,
    });

    const resized = selected.actionBus.dispatchState(
      RESIZE_MATH_MATRIX,
      selected,
      { rows: 3, cols: 3 },
    );
    const math = structuredToMathDocument(inlineMathDocument(resized.state)!);
    const matrix = math?.root.body.children.find(
      (node) => node.type === "matrix",
    );
    expect(resized.claimed).toBe(true);
    expect(resized.ops.length).toBeGreaterThan(0);
    expect(matrix?.type).toBe("matrix");
    if (matrix?.type !== "matrix") return;
    expect(matrix.rows).toHaveLength(3);
    expect(matrix.rows.every((row) => row.cells.length === 3)).toBe(true);
  });

  it("types inside an inline matrix cell without flattening its structure", () => {
    const latex = String.raw`\begin{bmatrix}a&b\\c&d\end{bmatrix}`;
    const entered = enterMathOffset(
      legacyChip("inline-matrix-input", `$${latex}$`),
      latex.indexOf("}a") + 2,
    );

    const inserted = insertText(entered, "x");

    expect(canonicalSource(inserted.state)).toBe(
      String.raw`\begin{bmatrix}ax&b\\c&d\end{bmatrix}`,
    );
    const document = inlineMathDocument(inserted.state);
    const math = document ? structuredToMathDocument(document) : undefined;
    const matrix = math?.root.body.children.find(
      (node) => node.type === "matrix",
    );
    expect(matrix?.type).toBe("matrix");
    if (matrix?.type !== "matrix") return;
    expect(matrix.rows.map((row) => row.cells.length)).toEqual([2, 2]);
  });

  it("keeps an inline matrix structured while a backslash is pending in a cell", () => {
    const latex = String.raw`\begin{bmatrix}a&b\\c&d\end{bmatrix}`;
    const entered = enterMathOffset(
      legacyChip("inline-matrix-backslash", `$${latex}$`),
      latex.indexOf("}a") + 2,
    );

    const typed = insertText(entered, "\\").state;

    expect(canonicalSource(typed)).toBe(
      String.raw`\begin{bmatrix}a\ &b\\c&d\end{bmatrix}`,
    );
    const document = inlineMathDocument(typed);
    const math = document ? structuredToMathDocument(document) : undefined;
    const matrix = math?.root.body.children.find(
      (node) => node.type === "matrix",
    );
    expect(matrix?.type).toBe("matrix");
    if (matrix?.type !== "matrix") return;
    expect(matrix.rows.map((row) => row.cells.length)).toEqual([2, 2]);
  });

  it("stores two typed backslashes as a symbol child of the current inline matrix-cell", () => {
    const latex = String.raw`\begin{bmatrix}a&b\\c&d\end{bmatrix}`;
    let state = enterMathOffset(
      legacyChip("inline-matrix-double-backslash", `$${latex}$`),
      latex.indexOf("}a") + 2,
    );
    const beforeMath = structuredToMathDocument(inlineMathDocument(state)!);
    const beforeMatrix = beforeMath?.root.body.children.find(
      (node) => node.type === "matrix",
    );
    if (beforeMatrix?.type !== "matrix") throw new Error("expected matrix");
    const cellIds = beforeMatrix.rows.flatMap((row) =>
      row.cells.map((cell) => cell.id),
    );

    state = insertText(state, "\\").state;
    state = insertText(state, "\\").state;

    expect(canonicalSource(state)).toBe(
      String.raw`\begin{bmatrix}a\backslash&b\\c&d\end{bmatrix}`,
    );
    const afterMath = structuredToMathDocument(inlineMathDocument(state)!);
    const afterMatrix = afterMath?.root.body.children.find(
      (node) => node.type === "matrix",
    );
    if (afterMatrix?.type !== "matrix") throw new Error("expected matrix");
    expect(
      afterMatrix.rows.flatMap((row) => row.cells.map((cell) => cell.id)),
    ).toEqual(cellIds);
    expect(afterMatrix.rows.map((row) => row.cells.length)).toEqual([2, 2]);
    expect(afterMatrix.rows[0].cells[0].body.children).toContainEqual(
      expect.objectContaining({ type: "symbol", command: "backslash" }),
    );
  });

  it("enters a legacy chip through the MathMark click action", () => {
    const initial = legacyChip();
    const before = {
      ...initial,
      ui: {
        ...initial.ui,
        inlineMathHover: { blockIndex: 0, startIndex: 0, endIndex: 1 },
      },
    };
    const entered = before.actionBus.dispatchState(TEXT_CLICK, before, {
      canvasX: 20,
      canvasY: 20,
      position: { blockIndex: 0, textIndex: 1 },
      previousMenu: before.ui.activeMenu,
      viewport: {
        width: 500,
        height: 300,
        scrollY: 0,
        documentHeight: 300,
      },
      modifiers: { ctrlOrMeta: false, shift: false },
    });

    expect(entered.claimed).toBe(true);
    expect(entered.ops.map((op) => op.op)).toEqual([
      "content_edit",
      "mark_set",
    ]);
    expect(entered.state.document.contentSelection).not.toBeNull();
    expect(compatibilitySource(entered.state)).toBe("x");
    expect(canonicalSource(entered.state)).toBe("x");
  });

  it("migrates on first direct insertion without mutating compatibility chars", () => {
    const before = enter(legacyChip());
    const edited = insertText(before, "2");

    expect(edited.ops.map((op) => op.op)).toEqual(["content_edit"]);
    expect(compatibilitySource(edited.state)).toBe("x");
    expect(canonicalSource(edited.state)).toBe("x2");
    expect(edited.state.document.contentSelection).not.toBeNull();
    expect(edited.state.document.cursor).toBeNull();
    expect(
      serializeToMarkdown(edited.state.document.page.blocks, undefined, {
        schema: edited.state.schema,
      }),
    ).toBe("$x2$");
  });

  it("routes backward and forward deletion only through the attachment", () => {
    const inserted = insertText(enter(legacyChip()), "2").state;
    const backward = inserted.actionBus.dispatchState(
      DELETE_BACKWARD,
      inserted,
    );
    expect(backward.claimed).toBe(true);
    expect(compatibilitySource(backward.state)).toBe("x");
    expect(canonicalSource(backward.state)).toBe("x");
    expect(backward.ops.every((op) => op.op === "content_edit")).toBe(true);

    const entered = enterInlineMathTreeAtPosition(legacyChip(), 0, 0, {
      allowBoundary: true,
    });
    expect(entered).toBeDefined();
    if (!entered) return;
    const forward = deleteActiveInlineMathTree(entered.state, "forward");
    expect(forward).toBeDefined();
    if (!forward) return;
    expect(compatibilitySource(forward.state)).toBe("x");
    expect(canonicalSource(forward.state)).toBe("");
    expect(
      serializeToMarkdown(forward.state.document.page.blocks, undefined, {
        schema: forward.state.schema,
      }),
    ).toBe("$$");
  });

  it("maps an attached replacement point and caret to stable ContentSelection", () => {
    const state = insertText(enter(legacyChip()), "2").state;
    const block = state.document.page.blocks[0];
    if (!isTextualBlock(block)) throw new Error("expected inline text host");
    const node = state.nodes.get(block.type) as TextNode;
    const maxWidth = 500;
    const styles = getEditorStyles(state);
    const layout = node.layout({
      block,
      blockIndex: 0,
      maxWidth,
      isFirst: true,
      styles,
      marks: state.marks,
    }) as TextNodeLayout;
    const line = layout.lines[0];
    const canonicalDims = state.marks
      .get("math")
      ?.replacement?.measure("x2", layout.textStyle.fontSize);
    expect(canonicalDims).not.toBeNull();
    expect(line.width).toBeCloseTo(canonicalDims?.width ?? 0);
    const selection = node.contentSelectionFromPoint(
      layout,
      { x: line.width * 0.75, y: layout.insetY + line.height / 2 },
      {
        state,
        block,
        blockIndex: 0,
        maxWidth,
        isFirst: true,
        styles,
        marks: state.marks,
      },
      { pointerType: "mouse" },
    );
    expect(selection).not.toBeNull();
    if (!selection) return;
    expect(selection.focus.contentId).toBe(
      state.document.contentSelection?.focus.contentId,
    );

    const selectedState = {
      ...state,
      document: {
        ...state.document,
        contentSelection: selection,
        cursor: null,
      },
    };
    const caret = node.caretRect(layout, 0, 0, 0, selectedState, block.id);
    expect(caret.exact).toBe(true);
    expect(caret.height).toBeGreaterThan(0);
  });

  it("keeps nested caret, hit-test, and drag on an LTR wrapped fragment", () => {
    const latex = "a+b+c+d+e+f+g+h+i+j+k+l+m+n+o+p";
    const markdown = `$${latex}$`;
    const sourceOffset = latex.indexOf("n") + 1;
    const state = enterMathOffset(
      legacyChip("inline-wrap-tree", markdown),
      sourceOffset,
    );
    const block = state.document.page.blocks[0];
    if (!isTextualBlock(block)) throw new Error("expected inline text host");
    const node = state.nodes.get(block.type) as TextNode;
    const maxWidth = 105;
    const styles = getEditorStyles(state);
    const layout = node.layout({
      block,
      blockIndex: 0,
      maxWidth,
      isFirst: true,
      styles,
      marks: state.marks,
    }) as TextNodeLayout;
    const expectedLine = layout.lines.find(
      (line) => sourceOffset >= line.startIndex && sourceOffset < line.endIndex,
    );
    expect(layout.lines.length).toBeGreaterThan(1);
    expect(expectedLine).toBeDefined();
    if (!expectedLine) return;

    const caret = node.caretRect(layout, 0, 0, 0, state, block.id);
    const caretMidY = caret.y + caret.height / 2;
    expect(caret.exact).toBe(true);
    expect(caretMidY).toBeGreaterThanOrEqual(expectedLine.y);
    expect(caretMidY).toBeLessThanOrEqual(expectedLine.y + expectedLine.height);
    const hit = node.contentSelectionFromPoint(
      layout,
      { x: caret.x, y: caretMidY },
      {
        state,
        block,
        blockIndex: 0,
        maxWidth,
        isFirst: true,
        styles,
        marks: state.marks,
      },
      { pointerType: "mouse" },
    );
    expect(hit?.focus.contentId).toBe(
      state.document.contentSelection?.focus.contentId,
    );

    const target = enterMathOffset(
      legacyChip("inline-wrap-tree", markdown),
      latex.indexOf("o") + 1,
    );
    const targetCaret = node.caretRect(layout, 0, 0, 0, target, block.id);
    const dragged = node.contentSelectionFromPoint(
      layout,
      { x: targetCaret.x, y: targetCaret.y + targetCaret.height / 2 },
      {
        state,
        block,
        blockIndex: 0,
        maxWidth,
        isFirst: true,
        styles,
        marks: state.marks,
      },
      {
        pointerType: "touch",
        drag: true,
        previousPoint: state.document.contentSelection?.focus,
      },
    );
    expect(dragged?.focus).toEqual(target.document.contentSelection?.focus);
  });

  it("keeps a diverged attached projection atomic without flattening identities", () => {
    const latex = "a+b+c+d+e+f+g+h+i+j+k+l+m+n+o+p";
    const entered = enterMathOffset(
      legacyChip("inline-atomic-projection", `$${latex}$`),
      latex.length,
    );
    const state = insertText(entered, "q").state;
    expect(compatibilitySource(state)).toBe(latex);
    expect(canonicalSource(state)).toBe(`${latex}q`);
    const block = state.document.page.blocks[0];
    if (!isTextualBlock(block)) throw new Error("expected inline text host");
    const node = state.nodes.get(block.type) as TextNode;
    const layout = node.layout({
      block,
      blockIndex: 0,
      maxWidth: 105,
      isFirst: true,
      styles: getEditorStyles(state),
      marks: state.marks,
    }) as TextNodeLayout;

    // Compatibility offsets no longer map one-to-one onto canonical source.
    // The generic host therefore keeps this projection as one overflowable box
    // instead of inventing flattened split points that could target wrong ids.
    expect(layout.lines).toHaveLength(1);
    expect(layout.lines[0].width).toBeGreaterThan(105);
  });

  it("round-trips nested RTL caret and vertical drag through visual bidi geometry", () => {
    const latex = String.raw`a+\frac{b}{c}+d`;
    const initial = legacyChip("inline-rtl-tree", `مرحبا $${latex}$ عالم`);
    const state = enterMathOffset(initial, latex.indexOf("c") + 1);
    const block = state.document.page.blocks[0];
    if (!isTextualBlock(block)) throw new Error("expected inline text host");
    const node = state.nodes.get(block.type) as TextNode;
    const maxWidth = 600;
    const styles = getEditorStyles(state);
    const layout = node.layout({
      block,
      blockIndex: 0,
      maxWidth,
      isFirst: true,
      styles,
      marks: state.marks,
    }) as TextNodeLayout;
    expect(layout.isRTL).toBe(true);

    const caret = node.caretRect(layout, 0, 0, 0, state, block.id);
    const point = { x: caret.x, y: caret.y + caret.height / 2 };
    expect(caret.exact).toBe(true);
    expect(caret.x).toBeGreaterThanOrEqual(0);
    expect(caret.x).toBeLessThanOrEqual(maxWidth);
    const hit = node.contentSelectionFromPoint(
      layout,
      point,
      {
        state,
        block,
        blockIndex: 0,
        maxWidth,
        isFirst: true,
        styles,
        marks: state.marks,
      },
      { pointerType: "mouse" },
    );
    expect(hit?.focus).toEqual(state.document.contentSelection?.focus);

    const target = enterMathOffset(
      legacyChip("inline-rtl-tree", `مرحبا $${latex}$ عالم`),
      latex.indexOf("b") + 1,
    );
    const targetCaret = node.caretRect(layout, 0, 0, 0, target, block.id);
    const dragged = node.contentSelectionFromPoint(
      layout,
      { x: targetCaret.x, y: targetCaret.y + targetCaret.height / 2 },
      {
        state,
        block,
        blockIndex: 0,
        maxWidth,
        isFirst: true,
        styles,
        marks: state.marks,
      },
      {
        pointerType: "touch",
        drag: true,
        previousPoint: state.document.contentSelection?.focus,
      },
    );
    expect(dragged?.focus).toEqual(target.document.contentSelection?.focus);
  });

  it("uses one deterministic migration tree for concurrent first edits", () => {
    const leftEntered = enterInlineMathTreeAtPosition(
      legacyChip("left"),
      0,
      1,
      { allowBoundary: true },
    );
    const rightEntered = enterInlineMathTreeAtPosition(
      legacyChip("right"),
      0,
      1,
      { allowBoundary: true },
    );
    expect(leftEntered).toBeDefined();
    expect(rightEntered).toBeDefined();
    if (!leftEntered || !rightEntered) return;
    const leftEdited = insertText(leftEntered.state, "a");
    const rightEdited = insertText(rightEntered.state, "b");
    const left = {
      ...leftEdited,
      ops: [...leftEntered.ops, ...leftEdited.ops],
    };
    const right = {
      ...rightEdited,
      ops: [...rightEntered.ops, ...rightEdited.ops],
    };
    const leftInit = left.ops.find(
      (op): op is ContentEdit =>
        op.op === "content_edit" && op.edit.kind === "document_init",
    );
    const rightInit = right.ops.find(
      (op): op is ContentEdit =>
        op.op === "content_edit" && op.edit.kind === "document_init",
    );
    expect(leftInit?.contentId).toBe(rightInit?.contentId);
    expect(leftInit?.edit).toEqual(rightInit?.edit);
    if (!leftInit || !rightInit || leftInit.edit.kind !== "document_init") {
      return;
    }
    const edits = (ops: readonly ContentEdit[]) =>
      ops
        .filter((op) => op.edit.kind !== "document_init")
        .map((op) => op.edit as StructuredEdit);
    const leftEdits = edits(
      left.ops.filter((op): op is ContentEdit => op.op === "content_edit"),
    );
    const rightEdits = edits(
      right.ops.filter((op): op is ContentEdit => op.op === "content_edit"),
    );
    const leftThenRight = applyStructuredEdits(
      applyStructuredEdits(leftInit.edit.document, leftEdits),
      rightEdits,
    );
    const rightThenLeft = applyStructuredEdits(
      applyStructuredEdits(leftInit.edit.document, rightEdits),
      leftEdits,
    );
    const source = (document: typeof leftThenRight) => {
      const math = structuredToMathDocument(document);
      return math ? printMathDocument(math) : undefined;
    };
    expect(source(leftThenRight)).toBe(source(rightThenLeft));
    expect(source(leftThenRight)).toContain("a");
    expect(source(leftThenRight)).toContain("b");
  });
});

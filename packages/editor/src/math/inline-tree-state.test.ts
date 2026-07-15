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
import { STRUCTURED_MARK_ANCHOR_CHAR } from "../feature-facets";
import { resolveMarkRuns } from "../inline-math-spans";
import { mathExtension } from "../math-extension";
import type { TextNode, TextNodeLayout } from "../nodes/TextNode";
import { createMarkRegistry } from "../rendering/marks";
import { MathMark } from "../rendering/marks/MathMark";
import { createNodeRegistry } from "../rendering/nodes";
import { baseSchema } from "../schema";
import { moveCursorToPosition, updateSelection } from "../selection";
import { loadPage } from "../serlization/loadPage";
import { serializeToMarkdown } from "../serlization/serializer";
import type { EditorState } from "../state-types";
import { createInitialState } from "../state-utils";
import { updateContentSelection } from "../structured-selection";
import { getEditorStyles } from "../styles";
import { isTextualBlock } from "../sync/block-registry";
import { getVisibleTextFromRuns } from "../sync/char-runs";
import { recordUndoOps, undoState } from "../sync/crdt-undo";
import { createCRDTbinding } from "../sync/sync";
import { INSERT_MATH_COMMAND, RESIZE_MATH_MATRIX } from "./actions";
import {
  getInlineMathStructuredDocument,
  getStructuredMathMarkSource,
  resolveStructuredInlineMathRuns,
} from "./inline-structured";
import {
  deleteActiveInlineMathTree,
  enterInlineMathTreeAtPosition,
} from "./inline-tree-state";
import { structuredToMathDocument } from "./structured";
import { mathContentSelectionFromSourceOffset } from "./tree-selection";
import { describe, expect, it } from "vitest";

const inlineTreeSchema = baseSchema.use(mathExtension());

/** One flat anchor char per chip — shorthand for readable flat-text asserts. */
const A = STRUCTURED_MARK_ANCHOR_CHAR;

function chipState(peer = "inline-test", markdown = "$x$"): EditorState {
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

/**
 * "a[xy]b" built through the selection-wrap API: `createFeatureMarkInRange`
 * replaces the covered chars with one anchor + eager attachment, so the flat
 * text is `a␣b` with the chip between the prose letters and the caret resting
 * on the chip's trailing edge.
 */
function proseWrappedChip(): EditorState {
  const binding = createCRDTbinding("page", "prose-wrapped");
  let page = loadPage("axyb", inlineTreeSchema.data);
  page = createFeatureMarkInRange(
    page,
    page.blocks[0].id,
    1,
    3,
    { type: "math" },
    binding,
    inlineTreeSchema.data,
  ).newPage;
  return moveCursorToPosition(
    createInitialState(page, {
      schema: inlineTreeSchema.data,
      nodes: createNodeRegistry(inlineTreeSchema.nodes),
      marks: createMarkRegistry(inlineTreeSchema.marks),
      crdtBinding: binding,
    }),
    0,
    2,
  );
}

function flatText(state: EditorState): string {
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

/**
 * A chip's interior has no flat positions, so a mid-formula caret is a nested
 * content selection at an offset into the chip's CANONICAL printed source.
 */
function enterMathOffset(
  state: EditorState,
  sourceOffset: number,
): EditorState {
  const block = state.document.page.blocks[0];
  if (!isTextualBlock(block)) throw new Error("expected a textual host block");
  const run = resolveStructuredInlineMathRuns(block)[0];
  if (!run?.contentId || !run.document) {
    throw new Error("expected an attached inline math run");
  }
  const selection = mathContentSelectionFromSourceOffset(
    block.id,
    run.contentId,
    run.document,
    sourceOffset,
  );
  if (!selection) throw new Error("expected a nested math caret");
  return updateContentSelection(state, selection);
}

/** The nested ContentPoint a caret at `sourceOffset` of the first run maps to. */
function nestedPointAtSourceOffset(state: EditorState, sourceOffset: number) {
  const block = state.document.page.blocks[0];
  if (!isTextualBlock(block)) throw new Error("expected a textual host block");
  const run = resolveStructuredInlineMathRuns(block)[0];
  if (!run?.contentId || !run.document) {
    throw new Error("expected an attached inline math run");
  }
  const selection = mathContentSelectionFromSourceOffset(
    block.id,
    run.contentId,
    run.document,
    sourceOffset,
  );
  if (!selection) throw new Error("expected a nested math caret");
  return selection.focus;
}

describe("interactive structured MathMark", () => {
  it("extends an inline tree selection with Shift+Left and Shift+Right", () => {
    const before = enterMathOffset(chipState("inline-horizontal", "$ab$"), 2);
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
        chipState(`inline-collapse-${_name}`, "$ab$"),
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
    const before = enter(chipState("inline-enter", "$x$tail"));
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
        chipState(`inline-select-${offset}`, `$${source}$`),
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

  it.each([
    ["Backspace", DELETE_BACKWARD, "right"],
    ["Delete", DELETE_FORWARD, "left"],
  ] as const)(
    "%s at a chip's flat edge selects the facing construct before deleting",
    (_label, action, edge) => {
      const source = String.raw`\frac{a}{b}`;
      const before = chipState(`inline-flat-edge-${edge}`, `$${source}$`);
      const run = resolveMarkRuns(before.document.page.blocks[0]).find(
        (candidate) => candidate.name === "math",
      );
      if (!run) throw new Error("expected an inline math run");
      const at = moveCursorToPosition(
        before,
        0,
        edge === "right" ? run.endIndex : run.startIndex,
      );

      const selected = at.actionBus.dispatchState(action, at);
      expect(selected.claimed).toBe(true);
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

  it("exposes highlight rects for the construct selected before deletion", () => {
    // Backspace at an inline matrix's trailing edge selects the matrix through
    // the tree (a nested selection — the flat cursor/range is cleared), so the
    // highlight must come from the replacement's contentSelectionRects seam.
    // Regression: the seam didn't exist and the selection was invisible.
    const source = String.raw`\begin{pmatrix}a&b\\c&d\end{pmatrix}`;
    const before = chipState("inline-select-rects", `$${source}$`);
    const run = resolveMarkRuns(before.document.page.blocks[0]).find(
      (candidate) => candidate.name === "math",
    );
    if (!run) throw new Error("expected an inline math run");
    const at = moveCursorToPosition(before, 0, run.endIndex);

    const selected = at.actionBus.dispatchState(DELETE_BACKWARD, at).state;
    const contentSelection = selected.document.contentSelection;
    expect(contentSelection).not.toBeNull();
    expect(contentSelection?.anchor).not.toEqual(contentSelection?.focus);

    const block = selected.document.page.blocks[0];
    if (!("formats" in block)) throw new Error("expected a textual block");
    const mark = block.formats[0]?.format;
    const text =
      getStructuredMathMarkSource(mark, block.structuredContent) ?? "";
    const rects = new MathMark().replacement?.contentSelectionRects?.(
      text,
      16,
      contentSelection!,
      { blockId: block.id, mark, attachments: block.structuredContent },
    );
    expect(rects?.length).toBeGreaterThan(0);
    for (const rect of rects!) {
      expect(rect.width).toBeGreaterThan(0);
      expect(rect.bottom).toBeGreaterThan(rect.top);
    }
  });

  it("removes an emptied chip on the next delete and restores it on undo", () => {
    // "a[xy]b" with the caret after the chip. Two Backspaces empty the formula
    // through the tree; the chip survives as an empty, still-editable nested
    // caret rather than vanishing mid-thought.
    let state = proseWrappedChip();
    for (let presses = 0; presses < 2; presses++) {
      state = state.actionBus.dispatchState(DELETE_BACKWARD, state).state;
    }
    expect(canonicalSource(state)).toBe("");
    expect(state.document.contentSelection).not.toBeNull();
    expect(flatText(state)).toBe(`a${A}b`);

    // The next Backspace deletes the chip itself: anchor char, covering mark,
    // and attachment all go, leaving a plain flat caret between the prose.
    const removed = state.actionBus.dispatchState(DELETE_BACKWARD, state);
    expect(removed.claimed).toBe(true);
    expect(flatText(removed.state)).toBe("ab");
    expect(inlineMathDocument(removed.state)).toBeUndefined();
    expect(resolveMarkRuns(removed.state.document.page.blocks[0])).toHaveLength(
      0,
    );
    expect(removed.state.document.contentSelection).toBeNull();
    expect(removed.state.document.cursor?.position).toEqual({
      blockIndex: 0,
      textIndex: 1,
    });
    expect(
      serializeToMarkdown(removed.state.document.page.blocks, undefined, {
        schema: removed.state.schema,
      }),
    ).toBe("ab");

    const recorded = recordUndoOps(
      state,
      removed.state,
      removed.ops,
      state.CRDTbinding.getPeerId(),
    );
    const undone = undoState(recorded).state;
    expect(flatText(undone)).toBe(`a${A}b`);
    expect(canonicalSource(undone)).toBe("");
  });

  it("deletes a chip whose attachment is broken instead of stranding it", () => {
    // A chip references its attachment by contentId; if the document is
    // missing (lost/invalid attachment) there is no tree to promote into, so
    // a facing Backspace removes the whole run rather than leaving an
    // undeletable anchor char behind.
    const initial = proseWrappedChip();
    const block = initial.document.page.blocks[0];
    if (!("formats" in block)) throw new Error("expected a textual block");
    const broken = {
      ...initial,
      document: {
        ...initial.document,
        page: {
          ...initial.document.page,
          blocks: [{ ...block, structuredContent: {} }],
        },
      },
    } as EditorState;

    const removed = broken.actionBus.dispatchState(DELETE_BACKWARD, broken);

    expect(removed.claimed).toBe(true);
    expect(flatText(removed.state)).toBe("ab");
    expect(resolveMarkRuns(removed.state.document.page.blocks[0])).toHaveLength(
      0,
    );
    expect(removed.state.document.cursor?.position).toEqual({
      blockIndex: 0,
      textIndex: 1,
    });
  });

  it("hands a boundary-facing delete back to the host text", () => {
    // Nested caret at the formula's first stop: Backspace faces out of the
    // chip. Nothing inside can be consumed, so the caret exits to the host
    // text at the chip edge instead of dying as a claimed no-op; the next
    // press continues into the surrounding prose.
    const atStart = enterMathOffset(chipState("inline-exit-left", "$xy$"), 0);
    const left = atStart.actionBus.dispatchState(DELETE_BACKWARD, atStart);
    expect(left.claimed).toBe(true);
    expect(left.ops).toEqual([]);
    expect(canonicalSource(left.state)).toBe("xy");
    expect(left.state.document.contentSelection).toBeNull();
    expect(left.state.document.cursor?.position).toEqual({
      blockIndex: 0,
      textIndex: 0,
    });

    const atEnd = enterMathOffset(chipState("inline-exit-right", "$xy$"), 2);
    const right = atEnd.actionBus.dispatchState(DELETE_FORWARD, atEnd);
    expect(right.claimed).toBe(true);
    expect(right.ops).toEqual([]);
    expect(canonicalSource(right.state)).toBe("xy");
    expect(right.state.document.contentSelection).toBeNull();
    expect(right.state.document.cursor?.position).toEqual({
      blockIndex: 0,
      textIndex: 1,
    });
  });

  it("reserves placeholder geometry for an empty chip", () => {
    // An empty formula must still measure: a null measure would leave the
    // renderer nothing to draw for the still-editable placeholder slot.
    const replacement = new MathMark().replacement;
    const dims = replacement.measure("", 16);
    expect(dims).not.toBeNull();
    expect(dims!.width).toBeGreaterThan(0);
    expect(dims!.height).toBeGreaterThan(0);
    expect(replacement.caretRect?.("", 16, 0)).toEqual({
      x: 0,
      top: -dims!.height,
      bottom: 0,
    });
    expect(replacement.hitTest?.("", 16, 5, 0)).toBe(0);
  });

  it("enters an attached chip's tree from its flat edges with arrows", () => {
    const before = proseWrappedChip();

    const fromEnd = moveCursorToPosition(before, 0, 2);
    const left = fromEnd.actionBus.dispatchState(MOVE_CURSOR_LEFT, fromEnd);
    expect(left.claimed).toBe(true);
    expect(left.ops).toEqual([]);
    expect(left.state.document.contentSelection).not.toBeNull();
    expect(left.state.document.cursor).toBeNull();

    const fromStart = moveCursorToPosition(before, 0, 1);
    const right = fromStart.actionBus.dispatchState(
      MOVE_CURSOR_RIGHT,
      fromStart,
    );
    expect(right.claimed).toBe(true);
    expect(right.ops).toEqual([]);
    expect(right.state.document.contentSelection).not.toBeNull();
    expect(right.state.document.cursor).toBeNull();
  });

  it("expands mixed prose/math selections to whole attached formulas", () => {
    // Flat text is "a␣b" — a chip is atomic to the flat model, so a range
    // touching the anchor char always addresses the whole formula.
    const before = proseWrappedChip();
    const clippedTail = updateSelection(before, {
      anchor: { blockIndex: 0, textIndex: 1 },
      focus: { blockIndex: 0, textIndex: 3 },
    });
    expect(buildClipboardPayload(clippedTail)?.markdown).toBe("$xy$b");
    const cut = clippedTail.actionBus.dispatchState(CUT, clippedTail);
    expect(flatText(cut.state)).toBe("a");
    expect(cut.ops.length).toBeGreaterThan(0);
    // Cutting the chip deletes the mark's attachment with it — nothing
    // references the document once the anchor char is a tombstone.
    expect(
      Object.keys(cut.state.document.page.blocks[0].structuredContent ?? {}),
    ).toHaveLength(0);

    const clippedHead = updateSelection(before, {
      anchor: { blockIndex: 0, textIndex: 0 },
      focus: { blockIndex: 0, textIndex: 2 },
    });
    const replaced = insertText(clippedHead, "Q");
    expect(flatText(replaced.state)).toBe("Qb");
    expect(replaced.ops.length).toBeGreaterThan(0);
    expect(
      serializeToMarkdown(replaced.state.document.page.blocks, undefined, {
        schema: replaced.state.schema,
      }),
    ).toBe("Qb");
  });

  it("defers atomic mixed-selection replacement until IME commit", () => {
    const selected = updateSelection(proseWrappedChip(), {
      anchor: { blockIndex: 0, textIndex: 0 },
      focus: { blockIndex: 0, textIndex: 2 },
    });
    const started = selected.actionBus.dispatchState(
      COMPOSITION_START,
      selected,
      { data: "Q" },
    );
    expect(started.ops).toEqual([]);
    expect(flatText(started.state)).toBe(`a${A}b`);

    const committed = started.state.actionBus.dispatchState(
      COMPOSITION_END,
      started.state,
      { data: "Q" },
    );
    expect(committed.ops.length).toBeGreaterThan(0);
    expect(flatText(committed.state)).toBe("Qb");
  });

  it("clones the attachment when native multi-block paste moves its mark", () => {
    const before = moveCursorToPosition(proseWrappedChip(), 0, 1);
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
        getVisibleTextFromRuns(candidate.charRuns) === `second${A}b`,
    );
    const contentId = (
      tail
        ? resolveMarkRuns(tail).find((run) => run.attrs.contentId)?.attrs
            .contentId
        : undefined
    ) as string | undefined;
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
    const before = updateSelection(proseWrappedChip(), {
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
    expect(enterInlineMathTreeAtPosition(chipState(), 0, 1)).toBeUndefined();
  });

  it("returns horizontal navigation to the host text past both tree edges", () => {
    // "a•b": the run boundary (index 2 / 1) is the same visual stop as the
    // tree edge caret that just failed to move, so the exit press continues
    // one flat step past it instead of parking on the boundary.
    const atEnd = enterMathOffset(chipState("inline-exit-right", "a$xy$b"), 2);
    const right = atEnd.actionBus.dispatchState(MOVE_CURSOR_RIGHT, atEnd);

    expect(right.claimed).toBe(true);
    expect(right.state.document.contentSelection).toBeNull();
    expect(right.state.document.cursor?.position).toEqual({
      blockIndex: 0,
      textIndex: 3,
    });

    const atStart = enterMathOffset(chipState("inline-exit-left", "a$xy$b"), 0);
    const left = atStart.actionBus.dispatchState(MOVE_CURSOR_LEFT, atStart);

    expect(left.claimed).toBe(true);
    expect(left.state.document.contentSelection).toBeNull();
    expect(left.state.document.cursor?.position).toEqual({
      blockIndex: 0,
      textIndex: 0,
    });
  });

  it("promotes a flat arrow step that lands on a chip edge into the tree", () => {
    // "a•b" — the chip's edge has ONE caret stop and it belongs to the
    // formula: the press whose flat step would land on the run boundary
    // produces the tree's edge caret directly, not the flat position in
    // front of the visually identical tree stop.
    const before = chipState("inline-approach", "a$xy$b");

    const fromLeft = moveCursorToPosition(before, 0, 0);
    const right = fromLeft.actionBus.dispatchState(
      MOVE_CURSOR_RIGHT,
      fromLeft,
    );
    expect(right.claimed).toBe(true);
    expect(right.state.document.cursor).toBeNull();
    expect(right.state.document.contentSelection?.focus).toEqual(
      nestedPointAtSourceOffset(right.state, 0),
    );

    const fromRight = moveCursorToPosition(before, 0, 3);
    const left = fromRight.actionBus.dispatchState(
      MOVE_CURSOR_LEFT,
      fromRight,
    );
    expect(left.claimed).toBe(true);
    expect(left.state.document.cursor).toBeNull();
    expect(left.state.document.contentSelection?.focus).toEqual(
      nestedPointAtSourceOffset(left.state, 2),
    );
  });

  it("exits one chip into a neighbouring chip's tree across one plain char", () => {
    // "a• •b" — two chips one space apart. Arrowing right off the first
    // formula's end crosses the space AND lands on the second chip's leading
    // edge, which promotes: one press moves from `x|` to `|y`.
    const before = chipState("inline-chip-hop", "a$x$ $y$b");
    const block = before.document.page.blocks[0];
    if (!isTextualBlock(block)) throw new Error("expected a textual block");
    const runs = resolveStructuredInlineMathRuns(block);
    expect(runs.map((run) => run.latex)).toEqual(["x", "y"]);
    const first = mathContentSelectionFromSourceOffset(
      block.id,
      runs[0].contentId!,
      runs[0].document!,
      1,
    );
    if (!first) throw new Error("expected a nested caret in the first chip");
    const inFirst = updateContentSelection(before, first);

    const hopped = inFirst.actionBus.dispatchState(MOVE_CURSOR_RIGHT, inFirst);

    expect(hopped.claimed).toBe(true);
    expect(hopped.state.document.contentSelection?.focus).toEqual(
      mathContentSelectionFromSourceOffset(
        block.id,
        runs[1].contentId!,
        runs[1].document!,
        0,
      )?.focus,
    );
  });

  it("routes horizontal and slot navigation through the inline tree", () => {
    const entered = enter(chipState("inline-nav"));
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

    const fraction = enterMathOffset(
      chipState("inline-tab", String.raw`$\frac{}{}$`),
      6,
    );
    const beforeTab = fraction.document.contentSelection?.focus;
    const tabbed = fraction.actionBus.dispatchState(
      MOVE_CONTENT_TAB,
      fraction,
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
    const entered = enterMathOffset(chipState("inline-command"), 0);
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
    expect(flatText(inserted.state)).toBe(A);
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
          getVisibleTextFromRuns([...node.textFields.text]).includes("sqrt"),
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
    const before = enterMathOffset(
      chipState("inline-matrix", `$${latex}$`),
      latex.indexOf("a") + 1,
    );

    const resized = before.actionBus.dispatchState(RESIZE_MATH_MATRIX, before, {
      rows: 3,
      cols: 3,
    });
    expect(resized.claimed).toBe(true);
    expect(resized.ops.length).toBeGreaterThan(0);
    expect(flatText(resized.state)).toBe(A);
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
      before,
      resized.state,
      resized.ops,
      before.CRDTbinding.getPeerId(),
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
    const before = enterMathOffset(
      chipState("inline-selected-matrix", `$${latex}$`),
      latex.indexOf("a&b"),
    );
    const document = inlineMathDocument(before);
    if (!document) throw new Error("expected structured inline matrix");
    const point = before.document.contentSelection?.focus;
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
    const selected = updateContentSelection(before, {
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
      chipState("inline-matrix-input", `$${latex}$`),
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
      chipState("inline-matrix-backslash", `$${latex}$`),
      latex.indexOf("}a") + 2,
    );

    const typed = insertText(entered, "\\").state;

    expect(canonicalSource(typed)).toBe(
      String.raw`\begin{bmatrix}a\backslash&b\\c&d\end{bmatrix}`,
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
      chipState("inline-matrix-double-backslash", `$${latex}$`),
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

  it("enters an attached chip through the MathMark click action", () => {
    const initial = chipState();
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

    // Entering an already-attached chip is pure selection state — no
    // migration, no ops.
    expect(entered.claimed).toBe(true);
    expect(entered.ops).toEqual([]);
    expect(entered.state.document.contentSelection).not.toBeNull();
    expect(canonicalSource(entered.state)).toBe("x");
  });

  it("routes direct insertion through the attachment only", () => {
    const before = enter(chipState());
    const edited = insertText(before, "2");

    // The anchor char never changes: the keystroke is one content_edit.
    expect(edited.ops.map((op) => op.op)).toEqual(["content_edit"]);
    expect(flatText(edited.state)).toBe(A);
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
    const inserted = insertText(enter(chipState()), "2").state;
    const backward = inserted.actionBus.dispatchState(
      DELETE_BACKWARD,
      inserted,
    );
    expect(backward.claimed).toBe(true);
    expect(flatText(backward.state)).toBe(A);
    expect(canonicalSource(backward.state)).toBe("x");
    expect(backward.ops.every((op) => op.op === "content_edit")).toBe(true);

    const entered = enterMathOffset(chipState(), 0);
    const forward = deleteActiveInlineMathTree(entered, "forward");
    expect(forward).toBeDefined();
    if (!forward) return;
    expect(flatText(forward.state)).toBe(A);
    expect(canonicalSource(forward.state)).toBe("");
    expect(
      serializeToMarkdown(forward.state.document.page.blocks, undefined, {
        schema: forward.state.schema,
      }),
    ).toBe("$$");
  });

  it("maps an attached replacement point and caret to stable ContentSelection", () => {
    const state = insertText(enter(chipState()), "2").state;
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

  it("keeps a chip wider than the line as one atomic overflowing box", () => {
    // A chip wraps only as a whole unit: there are no operator breakpoints
    // anymore, so a formula wider than the line overflows instead of being
    // divided across lines at flat offsets that no longer exist.
    const latex = "a+b+c+d+e+f+g+h+i+j+k+l+m+n+o+p";
    const state = enterMathOffset(
      chipState("inline-atomic-chip", `$${latex}$`),
      latex.length,
    );
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

    expect(layout.lines).toHaveLength(1);
    expect(layout.lines[0].width).toBeGreaterThan(105);
  });

  it("round-trips nested RTL caret and vertical drag through visual bidi geometry", () => {
    const latex = String.raw`a+\frac{b}{c}+d`;
    const initial = chipState("inline-rtl-tree", `مرحبا $${latex}$ عالم`);
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

    const target = enterMathOffset(state, latex.indexOf("b") + 1);
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
});

import { TEXT_INPUT } from "../action-bus";
import { insertText } from "../actions/actions";
import {
  cutSelectionToClipboard,
  type HostClipboard,
  pasteFromClipboardEvent,
  pasteFromSystemClipboard,
} from "../actions/clipboard";
import {
  DELETE_BACKWARD,
  DELETE_FORWARD,
  DELETE_WORD_BACKWARD,
  DELETE_WORD_FORWARD,
  SELECT_ALL,
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
import {
  SELECT_LINE_AT_POINT,
  SELECT_WORD_AT_POINT,
} from "../actions/mouse-actions";
import { handleKeyDown } from "../events/keysEvents";
import { resolveMarkRuns } from "../inline-math-spans";
import { mathExtension } from "../math-extension";
import { INSERT_MATH_COMMAND, RESIZE_MATH_MATRIX } from "../nodes/MathNode";
import { createMarkRegistry } from "../rendering/marks";
import { createNodeRegistry } from "../rendering/nodes";
import { baseSchema } from "../schema";
import {
  moveCursorToPosition,
  updateCursor,
  updateSelection,
} from "../selection";
import { loadPage } from "../serlization/loadPage";
import { serializeToMarkdown } from "../serlization/serializer";
import type { EditorState, Operation, ViewportState } from "../state-types";
import { createInitialState } from "../state-utils";
import {
  type ContentPoint,
  resolveContentTextPointOffset,
  updateContentSelection,
} from "../structured-selection";
import { getVisibleTextFromRuns, iterateAllChars } from "../sync/char-runs";
import { recordUndoOps, redoState, undoState } from "../sync/crdt-undo";
import { applyOps } from "../sync/reducer";
import { blocksToOps } from "../sync/snapshot-diff";
import { applyStructuredEdits } from "../sync/structured-content";
import { createCRDTbinding, createSyncEngine } from "../sync/sync";
import {
  getMathStructuredDocument,
  getStructuredMathSource,
  structuredToMathDocument,
} from "./structured";
import {
  contentPointToMathTreeCaret,
  mathContentSelectionFromSourceOffset,
  mathSourceRangeFromContentSelection,
} from "./tree-selection";
import { deleteActiveMathTreeSelection } from "./tree-state";
import {
  isValidLatex,
  layoutMathDocument,
  mathDocumentCaretStop,
} from "@cypherkit/tex";
import { describe, expect, it } from "vitest";

const treeMathSchema = baseSchema.use(mathExtension());

const viewport: ViewportState = {
  width: 800,
  height: 600,
  scrollY: 0,
  documentHeight: 2_000,
};

function keydown(key: string): Event {
  return {
    key,
    code: `Key${key.toUpperCase()}`,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
    preventDefault() {},
    stopPropagation() {},
  } as unknown as Event;
}

function treeState(
  markdown: string,
  binding = createCRDTbinding("default-page", "tree-test"),
): EditorState {
  return stateFromPage(loadPage(markdown, treeMathSchema.data), binding);
}

function stateFromPage(
  page: ReturnType<typeof loadPage>,
  binding: ReturnType<typeof createCRDTbinding>,
): EditorState {
  return createInitialState(page, {
    schema: treeMathSchema.data,
    nodes: createNodeRegistry(treeMathSchema.nodes),
    marks: createMarkRegistry(treeMathSchema.marks),
    crdtBinding: binding,
  });
}

// A math block owns no flat text, so the only flat caret it offers is the
// block edge at index 0; the first keystroke from there enters the tree.
function placeFlatCaretAtBlockEdge(state: EditorState): EditorState {
  return moveCursorToPosition(state, 0, 0);
}

// Nested caret at a LaTeX source offset of the block-authority document —
// the only way to address the interior of an equation (flat offsets into a
// math block resolve to nothing).
function placeTreeCaret(state: EditorState, sourceOffset: number): EditorState {
  const document = getMathStructuredDocument(block(state));
  if (!document) throw new Error("expected a block-authority math document");
  const selection = mathContentSelectionFromSourceOffset(
    block(state).id,
    document.rootId,
    document,
    sourceOffset,
  );
  if (!selection) {
    throw new Error(`no tree caret at source offset ${sourceOffset}`);
  }
  return updateContentSelection(state, selection);
}

function typeText(
  state: EditorState,
  text: string,
): { state: EditorState; lastOps: Operation[] } {
  if (!state.document.cursor && !state.document.contentSelection) {
    state = placeFlatCaretAtBlockEdge(state);
  }
  let lastOps: Operation[] = [];
  for (const char of text) {
    const result = insertText(state, char);
    state = result.state;
    lastOps = result.ops;
  }
  return { state, lastOps };
}

function block(state: EditorState) {
  return state.document.page.blocks[0];
}

function legacySource(state: EditorState): string {
  const current = block(state);
  return "charRuns" in current ? getVisibleTextFromRuns(current.charRuns) : "";
}

function treeSource(state: EditorState): string | undefined {
  return getStructuredMathSource(block(state));
}

function placeFlatTreeCursor(
  state: EditorState,
  textIndex: number,
): EditorState {
  return updateCursor(state, { blockIndex: 0, textIndex });
}

function contentTextOffset(state: EditorState): number | null {
  const point = state.document.contentSelection?.focus;
  return point?.kind === "text"
    ? resolveContentTextPointOffset(state.document.page, point)
    : null;
}

function selectActiveTreeText(
  state: EditorState,
  anchorOffset: number,
  focusOffset: number,
): EditorState {
  const active = state.document.contentSelection?.focus;
  if (!active || active.kind !== "text") {
    throw new Error("expected an active tree text caret");
  }
  const document = getMathStructuredDocument(block(state));
  const node = document?.nodes[active.nodeId];
  if (!document || !node) throw new Error("expected an active raw-text node");
  const ids = [...iterateAllChars([...(node.textFields[active.field] ?? [])])]
    .filter((entry) => !entry.deleted)
    .map((entry) => entry.id);
  const at = (offset: number): typeof active => ({
    ...active,
    afterCharId: ids[offset - 1] ?? null,
  });
  return updateContentSelection(state, {
    anchor: at(anchorOffset),
    focus: at(focusOffset),
    lastUpdate: Date.now(),
  });
}

function operationKinds(ops: readonly Operation[]): string[] {
  return ops.map((op) =>
    op.op === "content_edit" ? `content:${op.edit.kind}` : op.op,
  );
}

describe("tree-backed display math state integration", () => {
  it("creates a paragraph on Enter while the tree owns the caret", () => {
    const before = typeText(treeState("$$\n\n$$"), "x").state;
    expect(before.document.cursor).toBeNull();
    expect(before.document.contentSelection).not.toBeNull();

    const result = before.actionBus.dispatchState(SPLIT_BLOCK, before);

    expect(result.claimed).toBe(true);
    expect(result.ops.map((op) => op.op)).toEqual(["block_insert"]);
    expect(
      result.state.document.page.blocks.map((block) => block.type),
    ).toEqual(["math", "paragraph"]);
    expect(result.state.document.contentSelection).toBeNull();
    expect(result.state.document.cursor?.position).toEqual({
      blockIndex: 1,
      textIndex: 0,
    });
    expect(treeSource(result.state)).toBe("x");
  });

  it("extends a nested selection with Shift+Left and Shift+Right", () => {
    const before = typeText(treeState("$$\n\n$$"), "ab").state;
    const anchor = before.document.contentSelection?.focus;

    const left = before.actionBus.dispatchState(EXTEND_SELECTION_LEFT, before);
    expect(left.claimed).toBe(true);
    expect(left.state.document.contentSelection?.anchor).toEqual(anchor);
    expect(contentTextOffset(left.state)).toBe(1);

    const right = left.state.actionBus.dispatchState(
      EXTEND_SELECTION_RIGHT,
      left.state,
    );
    expect(right.claimed).toBe(true);
    expect(right.state.document.contentSelection?.anchor).toEqual(anchor);
    expect(right.state.document.contentSelection?.focus).toEqual(anchor);
  });

  it.each([
    ["left", MOVE_CURSOR_LEFT],
    ["right", MOVE_CURSOR_RIGHT],
  ] as const)(
    "collapses a full nested selection with Arrow%s",
    (_name, action) => {
      const before = typeText(treeState("$$\n\n$$"), "ab").state;
      const selected = before.actionBus.dispatchState(SELECT_ALL, before).state;
      expect(selected.document.contentSelection?.anchor).not.toEqual(
        selected.document.contentSelection?.focus,
      );

      const moved = selected.actionBus.dispatchState(action, selected);

      expect(moved.claimed).toBe(true);
      expect(moved.state.document.contentSelection?.anchor).toEqual(
        moved.state.document.contentSelection?.focus,
      );
    },
  );

  it("scopes the first Select All to the tree and the second to the document", () => {
    const before = typeText(treeState("$$\n\n$$\n\nafter"), "ab").state;
    const first = before.actionBus.dispatchState(SELECT_ALL, before);

    expect(first.claimed).toBe(true);
    expect(first.state.document.contentSelection).not.toBeNull();
    expect(first.state.document.selection).toBeNull();

    const second = first.state.actionBus.dispatchState(SELECT_ALL, first.state);
    expect(second.claimed).toBe(false);
    expect(second.state.document.contentSelection).toBeNull();
    expect(second.state.document.selection?.anchor).toEqual({
      blockIndex: 0,
      textIndex: 0,
    });
    expect(second.state.document.selection?.focus).toEqual({
      blockIndex: 2,
      textIndex: 5,
    });
  });

  it("demotes a structured display equation to the same structured inline math", () => {
    const before = selectActiveTreeText(
      typeText(treeState("$$\n\n$$"), "ab").state,
      0,
      0,
    );
    const original = getMathStructuredDocument(block(before));
    if (!original) throw new Error("expected a display attachment");

    const result = before.actionBus.dispatchState(DELETE_BACKWARD, before);
    const converted = result.state.document.page.blocks[0];
    const inlineContentId = resolveMarkRuns(converted)[0]?.attrs.contentId;
    const attachment =
      typeof inlineContentId === "string"
        ? converted.structuredContent?.[inlineContentId]
        : undefined;

    expect(result.claimed).toBe(true);
    expect(operationKinds(result.ops)).toEqual([
      "content:document_delete",
      "block_set",
      "content:document_init",
      "text_insert",
      "mark_set",
    ]);
    expect(converted.type).toBe("paragraph");
    expect(inlineContentId).not.toBe(original.rootId);
    expect(attachment?.authority).toBeUndefined();
    expect(attachment?.rootId).toBe(inlineContentId);
    expect(
      serializeToMarkdown(result.state.document.page.blocks, undefined, {
        schema: result.state.schema,
      }),
    ).toBe("$ab$");
    expect(result.state.document.contentSelection).toBeNull();
    // The caret stays at the leading edge where the backspace happened.
    expect(result.state.document.cursor?.position).toEqual({
      blockIndex: 0,
      textIndex: 0,
    });
    expect(applyOps(before.document.page, result.ops, before.schema)).toEqual(
      result.state.document.page,
    );

    const recorded = recordUndoOps(
      before,
      result.state,
      result.ops,
      before.CRDTbinding.getPeerId(),
    );
    const undone = undoState(recorded).state;
    expect(undone.document.page.blocks[0].type).toBe("math");
    expect(getStructuredMathSource(block(undone))).toBe("ab");
    const redone = redoState(undone).state;
    expect(
      serializeToMarkdown(redone.document.page.blocks, undefined, {
        schema: redone.schema,
      }),
    ).toBe("$ab$");
  });

  it("emits a nested TEXT_INPUT signal when a tree consumes backslash", () => {
    let state = placeFlatCaretAtBlockEdge(treeState("$$\n\n$$"));
    state = { ...state, view: { ...state.view, isFocused: true } };
    let observedPoint: ContentPoint | undefined;
    let trigger: { blockId: string; backslashIndex: number } | undefined;

    state.actionBus.register(
      TEXT_INPUT,
      ({ text, textIndex, contentPoint }) => {
        if (text !== "\\" || !contentPoint) return;
        observedPoint = contentPoint;
        trigger = {
          blockId: contentPoint.blockId,
          // The command menu resolves this sentinel from the committed tree
          // source on the following editor subscription tick.
          backslashIndex: -1,
        };
        expect(textIndex).toBe(0);
      },
    );

    const typed = handleKeyDown(state, viewport, keydown("\\")).state;
    const focus = typed.document.contentSelection?.focus;

    // The tree holds the literal pending `\`; its canonical projection spells
    // it `\backslash` so the scratch stays visible whether or not the caret is
    // still parked on it.
    expect(treeSource(typed)).toBe(String.raw`\backslash`);
    expect(typed.document.cursor).toBeNull();
    expect(focus).toMatchObject({
      kind: "text",
      blockId: block(typed).id,
    });
    expect(observedPoint).toEqual(focus);
    expect(trigger).toEqual({
      blockId: block(typed).id,
      backslashIndex: -1,
    });
  });

  it("keeps the tree authoritative when a fresh state re-mounts the page", () => {
    const seeded = typeText(treeState("$$\n\n$$"), "ab").state;
    let state = stateFromPage(seeded.document.page, seeded.CRDTbinding);
    state = placeFlatTreeCursor(state, 2);

    const result = insertText(state, "c");

    expect(operationKinds(result.ops)).toEqual(["content:text_insert"]);
    expect(legacySource(result.state)).toBe("");
    expect(treeSource(result.state)).toBe("abc");
    expect(result.state.document.cursor).toBeNull();
    expect(contentTextOffset(result.state)).toBe(3);
  });

  it("promotes flat cursors before tree Backspace, Arrow, and Tab actions", () => {
    const plain = typeText(treeState("$$\n\n$$"), "ab").state;

    const backedUp = plain.actionBus.dispatchState(
      DELETE_BACKWARD,
      placeFlatTreeCursor(plain, 2),
    );
    expect(backedUp.claimed).toBe(true);
    expect(operationKinds(backedUp.ops)).toEqual(["content:text_delete"]);
    expect(treeSource(backedUp.state)).toBe("a");
    expect(backedUp.state.document.cursor).toBeNull();
    expect(contentTextOffset(backedUp.state)).toBe(1);

    const moved = plain.actionBus.dispatchState(
      MOVE_CURSOR_RIGHT,
      placeFlatTreeCursor(plain, 0),
    );
    expect(moved.claimed).toBe(true);
    expect(moved.ops).toEqual([]);
    expect(moved.state.document.cursor).toBeNull();
    expect(contentTextOffset(moved.state)).toBe(1);

    const fraction = typeText(treeState("$$\n\n$$"), String.raw`\frac`).state;
    const tabbed = fraction.actionBus.dispatchState(
      MOVE_CONTENT_TAB,
      placeFlatTreeCursor(fraction, 6),
      { backward: false },
    );
    const document = getMathStructuredDocument(block(tabbed.state));
    const math = document ? structuredToMathDocument(document) : undefined;
    const fractionNode = math?.root.body.children[0];
    if (!fractionNode || fractionNode.type !== "fraction") {
      throw new Error("expected one structural fraction");
    }
    expect(tabbed.claimed).toBe(true);
    expect(tabbed.ops).toEqual([]);
    expect(tabbed.state.document.cursor).toBeNull();
    expect(tabbed.state.document.contentSelection?.focus).toMatchObject({
      kind: "gap",
      parentId: fractionNode.denominator.id,
    });
  });

  it("replaces a trailing command query and lands inside its first slot", () => {
    const state = typeText(treeState("$$\n\n$$"), String.raw`\sq`).state;
    const result = state.actionBus.dispatchState(INSERT_MATH_COMMAND, state, {
      text: String.raw`\sqrt{}`,
      caretOffset: 6,
    });

    expect(result.claimed).toBe(true);
    expect(treeSource(result.state)).toBe(String.raw`\sqrt{}`);
    expect(result.state.document.contentSelection?.focus).toMatchObject({
      kind: "gap",
      slot: "children",
      afterNodeId: null,
    });
    expect(operationKinds(result.ops)).toEqual([
      "content:text_delete",
      "content:node_insert",
      "content:node_insert",
    ]);
  });

  it("splices a semantic command at an interior tree caret", () => {
    const before = selectActiveTreeText(
      typeText(treeState("$$\n\n$$"), "ab").state,
      1,
      1,
    );
    const result = before.actionBus.dispatchState(INSERT_MATH_COMMAND, before, {
      text: String.raw`\sqrt{}`,
      caretOffset: 6,
    });

    expect(result.claimed).toBe(true);
    expect(treeSource(result.state)).toBe(String.raw`a\sqrt{}b`);
    expect(operationKinds(result.ops)).toEqual([
      "content:text_delete",
      "content:node_insert",
      "content:node_insert",
      "content:node_insert",
    ]);
    expect(result.state.document.contentSelection?.focus).toMatchObject({
      kind: "gap",
      afterNodeId: null,
    });
  });

  it("splices a semantic command at an interior caret of an imported equation", () => {
    // Same splice as above, but over the document `$$…$$` import attached —
    // proving a source-offset caret addresses imported identities directly.
    const before = placeTreeCaret(treeState("$$\nab\n$$"), 1);
    const result = before.actionBus.dispatchState(INSERT_MATH_COMMAND, before, {
      text: String.raw`\sqrt{}`,
      caretOffset: 6,
    });

    expect(result.claimed).toBe(true);
    expect(treeSource(result.state)).toBe(String.raw`a\sqrt{}b`);
    expect(operationKinds(result.ops)).toEqual([
      "content:text_delete",
      "content:node_insert",
      "content:node_insert",
      "content:node_insert",
    ]);
  });

  it("completes a manually typed command at an interior text caret", () => {
    const before = selectActiveTreeText(
      typeText(treeState("$$\n\n$$"), "ab").state,
      1,
      1,
    );
    const typed = typeText(before, String.raw`\sqrt`).state;
    const document = getMathStructuredDocument(block(typed));

    expect(treeSource(typed)).toBe(String.raw`a\sqrt{}b`);
    expect(
      Object.values(document?.nodes ?? {}).some(
        (node) => node.type === "radical" && !node.deleted,
      ),
    ).toBe(true);
    expect(typed.document.contentSelection?.focus).toMatchObject({
      kind: "gap",
      afterNodeId: null,
    });
  });

  it("semanticizes committed multi-character LaTeX before any deletion", () => {
    const before = placeFlatCaretAtBlockEdge(treeState("$$\n\n$$"));
    const inserted = insertText(before, String.raw`\sqrt{x}`).state;
    const document = getMathStructuredDocument(block(inserted));

    expect(treeSource(inserted)).toBe(String.raw`\sqrt{x}`);
    expect(
      Object.values(document?.nodes ?? {}).some(
        (node) => node.type === "radical" && !node.deleted,
      ),
    ).toBe(true);
    for (const node of Object.values(document?.nodes ?? {})) {
      if (node.type !== "raw-text") continue;
      expect(getVisibleTextFromRuns(node.textFields.text)).not.toMatch(
        /[\\{}^_&]/,
      );
    }

    const latex = treeSource(inserted)!;
    for (let offset = 0; offset <= latex.length; offset++) {
      for (const action of [DELETE_BACKWARD, DELETE_FORWARD] as const) {
        const deleted = inserted.actionBus.dispatchState(
          action,
          placeFlatTreeCursor(inserted, offset),
        ).state;
        expect(
          isValidLatex(treeSource(deleted) ?? ""),
          `${action.type} at ${offset}: ${treeSource(deleted)}`,
        ).toBe(true);
      }
    }
  });

  it("stores committed unsupported source as one exact atomic fallback", () => {
    for (const source of [String.raw`\wat{x}`, String.raw`\sq`, "ab&cd"]) {
      const before = placeFlatCaretAtBlockEdge(treeState("$$\n\n$$"));
      const inserted = insertText(before, source).state;
      const document = getMathStructuredDocument(block(inserted));
      const visible = Object.values(document?.nodes ?? {}).filter(
        (node) => !node.deleted,
      );

      expect(treeSource(inserted)).toBe(source);
      expect(
        visible.some((node) => node.type === "raw-latex"),
        `${source}: ${visible.map((node) => node.type).join(",")}`,
      ).toBe(true);
      expect(
        visible.some(
          (node) =>
            node.type === "raw-text" &&
            /[\\{}^_&]/.test(getVisibleTextFromRuns(node.textFields.text)),
        ),
      ).toBe(false);
    }
  });

  it("commits sequential escapes and unknown commands at their boundary", () => {
    for (const escaped of ["{", "}", "&", "^", "_", "%", "#", "$"]) {
      const inserted = typeText(treeState("$$\n\n$$"), `\\${escaped}`).state;
      const document = getMathStructuredDocument(block(inserted));
      const visible = Object.values(document?.nodes ?? {}).filter(
        (node) => !node.deleted,
      );
      expect(treeSource(inserted)).toBe(`\\${escaped}`);
      expect(
        visible.some(
          (node) => node.type === "symbol" || node.type === "raw-latex",
        ),
        escaped,
      ).toBe(true);
      expect(
        visible.some(
          (node) =>
            node.type === "raw-text" &&
            getVisibleTextFromRuns(node.textFields.text).includes("\\"),
        ),
      ).toBe(false);
    }

    const rowBreak = typeText(treeState("$$\n\n$$"), "\\\\").state;
    const rowBreakNodes = Object.values(
      getMathStructuredDocument(block(rowBreak))?.nodes ?? {},
    ).filter((node) => !node.deleted);
    expect(treeSource(rowBreak)).toBe("\\\\");
    expect(rowBreakNodes.some((node) => node.type === "raw-latex")).toBe(true);
    expect(
      rowBreakNodes.some(
        (node) =>
          node.type === "raw-text" &&
          getVisibleTextFromRuns(node.textFields.text).includes("\\"),
      ),
    ).toBe(false);

    const scratch = typeText(treeState("$$\n\n$$"), String.raw`\wa`).state;
    expect(
      Object.values(
        getMathStructuredDocument(block(scratch))?.nodes ?? {},
      ).some(
        (node) =>
          node.type === "raw-text" &&
          getVisibleTextFromRuns(node.textFields.text) === String.raw`\wa`,
      ),
    ).toBe(true);

    const committed = typeText(treeState("$$\n\n$$"), String.raw`\wat(`).state;
    const document = getMathStructuredDocument(block(committed));
    expect(treeSource(committed)).toBe(String.raw`\wat(`);
    expect(
      Object.values(document?.nodes ?? {}).some(
        (node) => node.type === "raw-latex" && !node.deleted,
      ),
    ).toBe(true);
    const deleted = committed.actionBus.dispatchState(
      DELETE_BACKWARD,
      placeFlatTreeCursor(committed, 3),
    ).state;
    expect(treeSource(deleted)).not.toContain(String.raw`\wt`);
  });

  it("semanticizes committed LaTeX from IME and plain-text paste", () => {
    const before = placeFlatCaretAtBlockEdge(treeState("$$\n\n$$"));
    const started = before.actionBus.dispatchState(COMPOSITION_START, before, {
      data: String.raw`\sqrt{x}`,
    });
    const composed = started.state.actionBus.dispatchState(
      COMPOSITION_END,
      started.state,
      { data: String.raw`\sqrt{x}` },
    ).state;
    expect(treeSource(composed)).toBe(String.raw`\sqrt{x}`);
    expect(
      Object.values(
        getMathStructuredDocument(block(composed))?.nodes ?? {},
      ).some((node) => node.type === "radical" && !node.deleted),
    ).toBe(true);

    const pasted = pasteFromClipboardEvent(
      placeFlatCaretAtBlockEdge(treeState("$$\n\n$$")),
      {} as ClipboardEvent,
      { html: "", text: String.raw`\sqrt{x}`, imageFile: null },
    );
    expect(pasted).not.toBeNull();
    expect(treeSource(pasted!.state)).toBe(String.raw`\sqrt{x}`);
    expect(
      Object.values(
        getMathStructuredDocument(block(pasted!.state))?.nodes ?? {},
      ).some((node) => node.type === "radical" && !node.deleted),
    ).toBe(true);
  });

  it("keeps non-BMP committed text intact", () => {
    const inserted = insertText(
      placeFlatCaretAtBlockEdge(treeState("$$\n\n$$")),
      "😀",
    ).state;
    // Math fonts cannot typeset an emoji glyph, so the commit wraps it in a
    // host-font `\text{…}` run — but the code point itself must survive whole
    // (no surrogate splitting).
    expect(treeSource(inserted)).toBe(String.raw`\text{😀}`);
  });

  it.each([
    ["^", "scripts"],
    ["_", "scripts"],
    ["{", "symbol"],
    ["}", "symbol"],
    ["&", "symbol"],
  ])("keeps structural key %s out of raw-text", (input, nodeType) => {
    const inserted = insertText(
      placeFlatCaretAtBlockEdge(treeState("$$\n\n$$")),
      input,
    ).state;
    const document = getMathStructuredDocument(block(inserted));
    const visible = Object.values(document?.nodes ?? {}).filter(
      (node) => !node.deleted,
    );

    expect(visible.some((node) => node.type === nodeType)).toBe(true);
    expect(
      visible.some(
        (node) =>
          node.type === "raw-text" &&
          /[{}^_&]/.test(getVisibleTextFromRuns(node.textFields.text)),
      ),
    ).toBe(false);
    expect(isValidLatex(treeSource(inserted) ?? "")).toBe(true);
  });

  it.each([
    ["F_2", "{F}_{2}"],
    ["x^2", "{x}^{2}"],
    ["ab_", "a{b}_{}"],
    [String.raw`\alpha_`, String.raw`{\alpha}_{}`],
  ])("binds the typed script in %s to the preceding atom", (input, source) => {
    const typed = typeText(treeState("$$\n\n$$"), input).state;
    expect(treeSource(typed)).toBe(source);
    expect(isValidLatex(treeSource(typed) ?? "")).toBe(true);
  });

  it("keeps the empty base slot for a script typed at a row start", () => {
    const typed = typeText(treeState("$$\n\n$$"), "_").state;
    expect(treeSource(typed)).toBe("{}_{}");
  });

  it("absorbs a preceding construct as the script base", () => {
    const radical = typeText(treeState("$$\n\n$$"), String.raw`\sqrt x`).state;
    const after = radical.actionBus.dispatchState(
      MOVE_CURSOR_RIGHT,
      radical,
    ).state;
    expect(treeSource(typeText(after, "_").state)).toBe(
      String.raw`{\sqrt{x}}_{}`,
    );
  });

  it("extends a preceding scripts node instead of nesting a second one", () => {
    const scripted = typeText(treeState("$$\n\n$$"), "x^2").state;
    const after = scripted.actionBus.dispatchState(
      MOVE_CURSOR_RIGHT,
      scripted,
    ).state;
    expect(treeSource(typeText(after, "_3").state)).toBe("{x}_{3}^{2}");
  });

  it("splits a leaf and absorbs the character before a mid-text script", () => {
    const typed = typeText(treeState("$$\n\n$$"), "ab").state;
    const mid = updateCursor(typed, { blockIndex: 0, textIndex: 1 });
    expect(treeSource(typeText(mid, "^").state)).toBe("{a}^{}b");
  });

  it("commits an exact prefix command before a delimiter or bulk suffix", () => {
    const delimited = typeText(treeState("$$\n\n$$"), String.raw`\sin(`).state;
    expect(treeSource(delimited)).toBe(String.raw`\sin(`);
    const document = getMathStructuredDocument(block(delimited));
    expect(
      Object.values(document?.nodes ?? {}).some(
        (node) => node.type === "operator" && !node.deleted,
      ),
    ).toBe(true);

    const source = treeSource(delimited)!;
    for (let offset = 0; offset <= source.length; offset++) {
      for (const action of [DELETE_BACKWARD, DELETE_FORWARD] as const) {
        const candidate = delimited.actionBus.dispatchState(
          action,
          placeFlatTreeCursor(delimited, offset),
        ).state;
        expect(
          isValidLatex(treeSource(candidate) ?? ""),
          `${action.type} at ${offset}: ${treeSource(candidate)}`,
        ).toBe(true);
      }
    }

    const deleted = delimited.actionBus.dispatchState(
      DELETE_BACKWARD,
      placeFlatTreeCursor(delimited, 4),
    ).state;
    expect(isValidLatex(treeSource(deleted) ?? "")).toBe(true);
    expect(treeSource(deleted)).not.toContain(String.raw`\sn`);

    const scratch = typeText(treeState("$$\n\n$$"), String.raw`\sin`).state;
    const suffixed = insertText(scratch, "hello").state;
    expect(isValidLatex(treeSource(suffixed) ?? "")).toBe(true);
    expect(treeSource(suffixed)).not.toContain(String.raw`\sinhello`);
  });

  it("deletes an exact withheld command atomically but keeps incomplete scratch editable", () => {
    const exact = typeText(treeState("$$\n\n$$"), String.raw`\sin`).state;
    const exactDeleted = exact.actionBus.dispatchState(
      DELETE_BACKWARD,
      placeFlatTreeCursor(exact, 3),
    ).state;
    expect(treeSource(exactDeleted)).toBe("");

    const incomplete = typeText(treeState("$$\n\n$$"), String.raw`\si`).state;
    const incompleteDeleted = incomplete.actionBus.dispatchState(
      DELETE_BACKWARD,
      placeFlatTreeCursor(incomplete, 3),
    ).state;
    expect(treeSource(incompleteDeleted)).toBe(String.raw`\s`);

    const partiallySelected = selectActiveTreeText(exact, 1, 3);
    const rangeDeleted = partiallySelected.actionBus.dispatchState(
      DELETE_BACKWARD,
      partiallySelected,
    ).state;
    expect(treeSource(rangeDeleted)).toBe("");
  });

  it("replaces a nested text range and restores its stable selection on undo", () => {
    const typed = typeText(treeState("$$\n\n$$"), "abcd").state;
    const before = selectActiveTreeText(typed, 1, 3);

    const replaced = insertText(before, "X");
    expect(treeSource(replaced.state)).toBe("aXd");
    expect(operationKinds(replaced.ops)).toEqual([
      "content:text_delete",
      "content:text_insert",
    ]);
    expect(contentTextOffset(replaced.state)).toBe(2);

    const recorded = recordUndoOps(
      before,
      replaced.state,
      replaced.ops,
      before.CRDTbinding.getPeerId(),
    );
    const undone = undoState(recorded).state;
    expect(treeSource(undone)).toBe("abcd");
    expect(undone.document.contentSelection).toEqual(
      before.document.contentSelection,
    );

    const redone = redoState(undone).state;
    expect(treeSource(redone)).toBe("aXd");
    expect(contentTextOffset(redone)).toBe(2);
  });

  it("uses the held nested range for both Backspace and forward Delete", () => {
    const typed = typeText(treeState("$$\n\n$$"), "abcd").state;
    const selected = selectActiveTreeText(typed, 1, 3);

    for (const action of [DELETE_BACKWARD, DELETE_FORWARD] as const) {
      const result = selected.actionBus.dispatchState(action, selected);
      expect(result.claimed).toBe(true);
      expect(treeSource(result.state)).toBe("ad");
      expect(operationKinds(result.ops)).toEqual(["content:text_delete"]);
      expect(contentTextOffset(result.state)).toBe(1);
    }
  });

  it("normalizes a selected anchor tombstoned by a concurrent peer", () => {
    const typed = typeText(treeState("$$\n\n$$"), "abcd").state;
    const selected = selectActiveTreeText(typed, 1, 4);
    const active = selected.document.contentSelection?.anchor;
    const document = getMathStructuredDocument(block(selected));
    if (!document || !active || active.kind !== "text") {
      throw new Error("expected one selected tree text field");
    }
    const remoteDocument = applyStructuredEdits(document, [
      {
        kind: "text_insert",
        nodeId: active.nodeId,
        field: active.field,
        afterCharId: null,
        charRuns: [{ peerId: "remote", startCounter: 900, text: "x" }],
      },
      {
        kind: "text_delete",
        nodeId: active.nodeId,
        field: active.field,
        charIds: [active.afterCharId!],
      },
    ]);
    const current = block(selected);
    const remoteState: EditorState = {
      ...selected,
      document: {
        ...selected.document,
        page: {
          ...selected.document.page,
          blocks: [
            {
              ...current,
              structuredContent: {
                ...current.structuredContent,
                [document.rootId]: remoteDocument,
              },
            },
            ...selected.document.page.blocks.slice(1),
          ],
        },
      },
    };

    const result = remoteState.actionBus.dispatchState(
      DELETE_BACKWARD,
      remoteState,
    );
    expect(treeSource(result.state)).toBe("x");
    expect(contentTextOffset(result.state)).toBe(1);
    expect(operationKinds(result.ops)).toEqual(["content:text_delete"]);
  });

  it("returns an explicit state-layer failure for a cross-slot range", () => {
    let state = typeText(treeState("$$\n\n$$"), String.raw`\frac`).state;
    const document = getMathStructuredDocument(block(state));
    const math = document ? structuredToMathDocument(document) : undefined;
    const fraction = math?.root.body.children[0];
    if (!document || !fraction || fraction.type !== "fraction") {
      throw new Error("expected a structural fraction");
    }
    state = updateContentSelection(state, {
      anchor: {
        kind: "gap",
        blockId: block(state).id,
        contentId: document.rootId,
        parentId: fraction.numerator.id,
        slot: "children",
        afterNodeId: null,
        affinity: "forward",
      },
      focus: {
        kind: "gap",
        blockId: block(state).id,
        contentId: document.rootId,
        parentId: fraction.denominator.id,
        slot: "children",
        afterNodeId: null,
        affinity: "forward",
      },
    });

    expect(deleteActiveMathTreeSelection(state)).toMatchObject({
      state,
      ops: [],
      handled: true,
      reason: "unsupported-cross-slot-range",
    });
  });

  it("appends to an imported equation through its attached document", () => {
    // `$$…$$` markdown imports with the block-authority document already
    // attached, so the first edit is a plain tree insertion — no init, no
    // flat-source cleanup — and it replays deterministically from ops.
    const before = placeTreeCaret(treeState("$$\nab\n$$"), 2);

    const result = insertText(before, "c");

    expect(operationKinds(result.ops)).toEqual(["content:text_insert"]);
    expect(treeSource(result.state)).toBe("abc");
    expect(result.state.document.cursor).toBeNull();
    expect(result.state.document.contentSelection?.focus.kind).toBe("text");
    expect(contentTextOffset(result.state)).toBe(3);

    const replayed = applyOps(
      before.document.page,
      result.ops,
      treeMathSchema.data,
    );
    expect(getStructuredMathSource(replayed.blocks[0])).toBe("abc");
    expect(
      serializeToMarkdown(result.state.document.page.blocks, undefined, {
        schema: treeMathSchema.data,
      }),
    ).toBe("$$\nabc\n$$");
  });

  it("deletes backward and forward from a source-offset caret", () => {
    for (const [action, offset] of [
      [DELETE_BACKWARD, 2],
      [DELETE_FORWARD, 1],
    ] as const) {
      const before = placeTreeCaret(treeState("$$\nabc\n$$"), offset);
      const result = before.actionBus.dispatchState(action, before);

      expect(result.claimed).toBe(true);
      expect(operationKinds(result.ops)).toEqual(["content:text_delete"]);
      expect(treeSource(result.state)).toBe("ac");
      expect(result.state.document.cursor).toBeNull();
    }
  });

  it.each([
    ["Backspace", DELETE_BACKWARD, 11],
    ["Delete", DELETE_FORWARD, 0],
  ] as const)(
    "%s selects a large construct before deleting it",
    (_label, action, offset) => {
      const source = String.raw`\frac{a}{b}`;
      const before = placeTreeCaret(treeState(`$$\n${source}\n$$`), offset);

      const selected = before.actionBus.dispatchState(action, before);
      expect(selected.claimed).toBe(true);
      expect(treeSource(selected.state)).toBe(source);
      expect(selected.state.document.contentSelection?.anchor).not.toEqual(
        selected.state.document.contentSelection?.focus,
      );

      // The construct IS the whole equation here, so the selection covers the
      // entire block (painted as a full-card highlight) — the second press
      // deletes the block itself, not just its content.
      const deleted = selected.state.actionBus.dispatchState(
        action,
        selected.state,
      );
      expect(block(deleted.state).deleted).toBe(true);
    },
  );

  it.each([
    ["plain text", "aa"],
    ["a construct", String.raw`\frac{a}{b}`],
  ] as const)(
    "deletes the whole block when a triple-click selection over %s is deleted",
    (_label, source) => {
      const before = treeState(`$$\n${source}\n$$`);
      const selected = before.actionBus.dispatchState(
        SELECT_LINE_AT_POINT,
        before,
        { position: { blockIndex: 0, textIndex: 0 } },
      );
      expect(selected.claimed).toBe(true);

      const deleted = selected.state.actionBus.dispatchState(
        DELETE_BACKWARD,
        selected.state,
      );
      expect(deleted.claimed).toBe(true);
      expect(block(deleted.state).deleted).toBe(true);
    },
  );

  it.each([
    ["Backspace", DELETE_BACKWARD, 13],
    ["Delete", DELETE_FORWARD, 2],
  ] as const)(
    "%s deletes only the selected construct when the equation has more content",
    (_label, action, offset) => {
      const source = String.raw`x+\frac{a}{b}`;
      const before = placeTreeCaret(treeState(`$$\n${source}\n$$`), offset);

      const selected = before.actionBus.dispatchState(action, before);
      expect(selected.claimed).toBe(true);
      expect(treeSource(selected.state)).toBe(source);

      const deleted = selected.state.actionBus.dispatchState(
        action,
        selected.state,
      );
      expect(block(deleted.state).deleted).toBeUndefined();
      expect(treeSource(deleted.state)).toBe("x+");
    },
  );

  it("routes the native cut action through the held nested range", () => {
    let before = placeTreeCaret(treeState("$$\nabcd\n$$"), 3);
    before = selectActiveTreeText(before, 1, 3);

    const result = before.actionBus.dispatchState(CUT, before);

    // CUT stays unclaimed so the host clipboard handler still captures the
    // event, but the nested range is already removed from the tree.
    expect(result.claimed).toBe(false);
    expect(operationKinds(result.ops)).toEqual(["content:text_delete"]);
    expect(treeSource(result.state)).toBe("ad");
  });

  it("routes async public cut through the held nested range", async () => {
    let before = placeTreeCaret(treeState("$$\nabcd\n$$"), 3);
    before = selectActiveTreeText(before, 1, 3);
    const clipboard: HostClipboard = {
      write: async () => {},
      read: async () => ({}),
    };

    const cut = await cutSelectionToClipboard(before, clipboard);

    expect(cut.success).toBe(true);
    expect(cut.result).not.toBeNull();
    expect(operationKinds(cut.result!.ops)).toEqual(["content:text_delete"]);
    expect(treeSource(cut.result!.state)).toBe("ad");
  });

  it("keeps a nested range intact until the IME commit replaces it", () => {
    let before = placeTreeCaret(treeState("$$\nabcd\n$$"), 3);
    before = selectActiveTreeText(before, 1, 3);

    const started = before.actionBus.dispatchState(COMPOSITION_START, before, {
      data: "あ",
    });
    // Composition previews paint host-side; the document only changes on commit.
    expect(started.ops).toEqual([]);
    expect(treeSource(started.state)).toBe("abcd");

    const committed = started.state.actionBus.dispatchState(
      COMPOSITION_END,
      started.state,
      { data: "あ" },
    );
    // Kana is prose to the math fonts, so the commit lands as a `\text{…}` run.
    expect(treeSource(committed.state)).toBe(String.raw`a\text{あ}d`);
    expect(operationKinds(committed.ops)).toContain("content:text_delete");
    expect(committed.ops.every((op) => op.op === "content_edit")).toBe(true);
  });

  it("prefers plain clipboard text at a nested caret over rich flat paste", () => {
    const before = placeTreeCaret(treeState("$$\nabcd\n$$"), 2);
    const pasted = pasteFromClipboardEvent(before, {} as ClipboardEvent, {
      html: "<p><strong>wrong-rich-surface</strong></p>",
      text: "X",
      imageFile: null,
    });

    expect(pasted).not.toBeNull();
    expect(operationKinds(pasted!.ops)).toEqual(["content:text_insert"]);
    expect(treeSource(pasted!.state)).toBe("abXcd");

    // Rich/image-only clipboard data has no lossless structured insertion in
    // this slice. It is conservatively rejected before the flat block parser.
    expect(
      pasteFromClipboardEvent(before, {} as ClipboardEvent, {
        html: "<p>rich-only</p>",
        text: "",
        imageFile: null,
      }),
    ).toBeNull();
  });

  it("routes host-system plain paste through the nested caret", async () => {
    const before = placeTreeCaret(treeState("$$\nabcd\n$$"), 2);
    const clipboard: HostClipboard = {
      write: async () => {},
      read: async () => ({
        html: "<p><strong>wrong-rich-surface</strong></p>",
        text: "Y",
      }),
    };

    const pasted = await pasteFromSystemClipboard(before, clipboard);

    expect(pasted).not.toBeNull();
    expect(treeSource(pasted!.state)).toBe("abYcd");
    expect(pasted!.ops.some((op) => op.op === "content_edit")).toBe(true);
  });

  it("deletes an authoritative tree atomically in a cross-block range", () => {
    let before = moveCursorToPosition(treeState("$$\n\n$$\n\noutside"), 0, 0);
    before = typeText(before, "abc").state;
    before = moveCursorToPosition(before, 1, 2);
    const outsideIndex = before.document.page.blocks.findIndex(
      (candidate) =>
        "charRuns" in candidate &&
        getVisibleTextFromRuns(candidate.charRuns) === "outside",
    );
    before = updateSelection(before, {
      anchor: { blockIndex: 0, textIndex: 2 },
      focus: { blockIndex: outsideIndex, textIndex: 2 },
    });

    for (const [mutate, expected] of [
      [
        (state: EditorState) =>
          state.actionBus.dispatchState(DELETE_BACKWARD, state),
        "tside",
      ],
      [(state: EditorState) => insertText(state, "X"), "Xtside"],
    ] as const) {
      const result = mutate(before);
      expect(result.ops.length).toBeGreaterThan(0);
      expect(treeSource(result.state)).toBe("abc");
      expect(legacySource(result.state)).toBe("");
      expect(block(result.state).deleted).toBe(true);
      expect(
        serializeToMarkdown(result.state.document.page.blocks, undefined, {
          schema: result.state.schema,
        }),
      ).toBe(expected);
    }
  });

  it("keeps word deletion unit-wise inside the tree", () => {
    // A "word" never crosses a construct or the equation edge; the caret's
    // neighbouring unit is the largest safe target.
    for (const [action, offset, expected] of [
      [DELETE_WORD_BACKWARD, 3, "ab"],
      [DELETE_WORD_FORWARD, 0, "bc"],
    ] as const) {
      const before = placeTreeCaret(treeState("$$\nabc\n$$"), offset);
      const result = before.actionBus.dispatchState(action, before);

      expect(result.claimed).toBe(true);
      expect(operationKinds(result.ops)).toEqual(["content:text_delete"]);
      expect(treeSource(result.state)).toBe(expected);
    }
  });

  it("resizes a structured matrix through the public action and undoes it", () => {
    const latex = String.raw`\begin{bmatrix}a&b\\c&d\end{bmatrix}`;
    const before = placeTreeCaret(
      treeState(`$$\n${latex}\n$$`),
      latex.indexOf("a&b") + 1,
    );

    const grown = before.actionBus.dispatchState(RESIZE_MATH_MATRIX, before, {
      rows: 3,
      cols: 3,
    });
    const grownDocument = getMathStructuredDocument(block(grown.state));
    const grownMath = grownDocument
      ? structuredToMathDocument(grownDocument)
      : undefined;
    const matrix = grownMath?.root.body.children.find(
      (node) => node.type === "matrix",
    );
    expect(grown.claimed).toBe(true);
    expect(matrix?.type).toBe("matrix");
    if (matrix?.type !== "matrix") throw new Error("expected matrix");
    expect(matrix.rows).toHaveLength(3);
    expect(matrix.rows.map((row) => row.cells.length)).toEqual([3, 3, 3]);
    expect(
      grown.ops.every(
        (op) =>
          op.op !== "content_edit" ||
          op.edit.kind === "node_insert" ||
          op.edit.kind === "node_attr_set",
      ),
    ).toBe(true);
    const replayed = applyOps(
      before.document.page,
      grown.ops,
      treeMathSchema.data,
    );
    expect(getStructuredMathSource(replayed.blocks[0])).toBe(
      treeSource(grown.state),
    );

    const recorded = recordUndoOps(
      before,
      grown.state,
      grown.ops,
      before.CRDTbinding.getPeerId(),
    );
    const undone = undoState(recorded).state;
    expect(treeSource(undone)).toBe(latex);

    const shrunk = grown.state.actionBus.dispatchState(
      RESIZE_MATH_MATRIX,
      grown.state,
      { rows: 1, cols: 1 },
    );
    const shrunkDocument = getMathStructuredDocument(block(shrunk.state));
    const shrunkMath = shrunkDocument
      ? structuredToMathDocument(shrunkDocument)
      : undefined;
    const shrunkMatrix = shrunkMath?.root.body.children.find(
      (node) => node.type === "matrix",
    );
    expect(shrunkMatrix?.type).toBe("matrix");
    if (shrunkMatrix?.type !== "matrix") throw new Error("expected matrix");
    expect(shrunkMatrix.rows).toHaveLength(1);
    expect(shrunkMatrix.rows[0].cells).toHaveLength(1);
  });

  it("resizes a whole selected structured matrix from its opening endpoint", () => {
    const latex = String.raw`\frac{a}{b}\begin{bmatrix}a&b\\c&d\end{bmatrix}`;
    let state = moveCursorToPosition(
      treeState(`$$\n${latex}\n$$`),
      0,
      latex.length,
    );
    state = insertText(state, "").state;
    const document = getMathStructuredDocument(block(state));
    if (!document) throw new Error("expected structured matrix");
    const blockId = block(state).id;
    const contentId = document.rootId;
    const anchor = mathContentSelectionFromSourceOffset(
      blockId,
      contentId,
      document,
      latex.indexOf("\\begin"),
    );
    const focus = mathContentSelectionFromSourceOffset(
      blockId,
      contentId,
      document,
      latex.length,
    );
    if (!anchor || !focus) throw new Error("expected matrix boundary range");
    const selected = updateContentSelection(state, {
      anchor: anchor.focus,
      focus: focus.focus,
    });

    const resized = selected.actionBus.dispatchState(
      RESIZE_MATH_MATRIX,
      selected,
      { rows: 3, cols: 3 },
    );
    const resizedDocument = getMathStructuredDocument(block(resized.state));
    const math = resizedDocument
      ? structuredToMathDocument(resizedDocument)
      : undefined;
    const matrix = math?.root.body.children.find(
      (node) => node.type === "matrix",
    );
    expect(resized.claimed).toBe(true);
    expect(resized.ops.length).toBeGreaterThan(0);
    expect(matrix?.type).toBe("matrix");
    if (matrix?.type !== "matrix") throw new Error("expected matrix");
    expect(matrix.rows).toHaveLength(3);
    expect(matrix.rows.every((row) => row.cells.length === 3)).toBe(true);
  });

  it("promotes a double-click construct selection to the nested model", () => {
    // Double-clicking a matrix resolves the whole construct, but committing it
    // as a flat range over a tree-backed equation points into a phantom source
    // (the legacy text is empty): copy and the host's matrix probes read "",
    // so "Edit matrix" never appears. The gesture must land as contentSelection.
    const latex = String.raw`\frac{a}{b}\begin{bmatrix}a&b\\c&d\end{bmatrix}`;
    let state = moveCursorToPosition(
      treeState(`$$\n${latex}\n$$`),
      0,
      latex.length,
    );
    state = insertText(state, "").state;
    expect(getMathStructuredDocument(block(state))).toBeDefined();
    const spanStart = latex.indexOf("\\begin");

    const selected = state.actionBus.dispatchState(
      SELECT_WORD_AT_POINT,
      state,
      {
        position: { blockIndex: 0, textIndex: spanStart + 1 },
        range: { start: spanStart, end: latex.length },
      },
    );
    expect(selected.claimed).toBe(true);
    const content = selected.state.document.contentSelection;
    expect(content).not.toBeNull();
    expect(selected.state.document.selection).toBeNull();

    const resized = selected.state.actionBus.dispatchState(
      RESIZE_MATH_MATRIX,
      selected.state,
      { rows: 3, cols: 3 },
    );
    const resizedDocument = getMathStructuredDocument(block(resized.state));
    const math = resizedDocument
      ? structuredToMathDocument(resizedDocument)
      : undefined;
    const matrix = math?.root.body.children.find(
      (node) => node.type === "matrix",
    );
    expect(resized.claimed).toBe(true);
    expect(matrix?.type).toBe("matrix");
    if (matrix?.type !== "matrix") throw new Error("expected matrix");
    expect(matrix.rows).toHaveLength(3);
    expect(matrix.rows.every((row) => row.cells.length === 3)).toBe(true);
  });

  it("selects the whole equation as a nested selection on triple-click", () => {
    // The default triple-click line select reads the block's flat text, which
    // a tree-backed equation leaves empty — nothing would be selected. The
    // math node claims the gesture and selects the whole equation nested.
    const latex = String.raw`\frac{a}{b}\begin{bmatrix}a&b\\c&d\end{bmatrix}`;
    let state = moveCursorToPosition(
      treeState(`$$\n${latex}\n$$`),
      0,
      latex.length,
    );
    state = insertText(state, "").state;
    expect(getMathStructuredDocument(block(state))).toBeDefined();

    const selected = state.actionBus.dispatchState(
      SELECT_LINE_AT_POINT,
      state,
      { position: { blockIndex: 0, textIndex: 0 } },
    );
    expect(selected.claimed).toBe(true);
    expect(selected.state.document.contentSelection).not.toBeNull();
    expect(selected.state.document.selection).toBeNull();

    // The whole-equation selection contains the matrix, so the resize dialog
    // must reach it through the swept range.
    const resized = selected.state.actionBus.dispatchState(
      RESIZE_MATH_MATRIX,
      selected.state,
      { rows: 3, cols: 3 },
    );
    const resizedDocument = getMathStructuredDocument(block(resized.state));
    const math = resizedDocument
      ? structuredToMathDocument(resizedDocument)
      : undefined;
    const matrix = math?.root.body.children.find(
      (node) => node.type === "matrix",
    );
    expect(resized.claimed).toBe(true);
    expect(matrix?.type).toBe("matrix");
    if (matrix?.type !== "matrix") throw new Error("expected matrix");
    expect(matrix.rows).toHaveLength(3);
    expect(matrix.rows.every((row) => row.cells.length === 3)).toBe(true);
  });

  it("takes a matrix whole when shift+right steps into it from outside", () => {
    // Extending the selection with shift+arrows must never leave the focus
    // inside a construct the anchor is not in — that partial state cannot be
    // painted or edited sensibly. One step across the matrix boundary selects
    // the whole matrix.
    const latex = String.raw`x\begin{bmatrix}a&b\\c&d\end{bmatrix}y`;
    let state = moveCursorToPosition(
      treeState(`$$\n${latex}\n$$`),
      0,
      latex.length,
    );
    state = insertText(state, "").state;
    const document = getMathStructuredDocument(block(state));
    if (!document) throw new Error("expected structured matrix");
    const spanStart = latex.indexOf("\\begin");
    const spanEnd = latex.indexOf("\\end{bmatrix}") + "\\end{bmatrix}".length;
    const caret = mathContentSelectionFromSourceOffset(
      block(state).id,
      document.rootId,
      document,
      spanStart,
    );
    if (!caret) throw new Error("expected caret before the matrix");
    state = updateContentSelection(state, caret);

    const extended = state.actionBus.dispatchState(
      EXTEND_SELECTION_RIGHT,
      state,
    );
    expect(extended.claimed).toBe(true);
    const selection = extended.state.document.contentSelection;
    const after = getMathStructuredDocument(block(extended.state));
    if (!selection || !after) throw new Error("expected nested selection");
    expect(mathSourceRangeFromContentSelection(after, selection)).toEqual({
      from: spanStart,
      to: spanEnd,
    });
    // Both endpoints rest in the matrix's own row — never inside a cell.
    const anchorCaret = contentPointToMathTreeCaret(after, selection.anchor);
    const focusCaret = contentPointToMathTreeCaret(after, selection.focus);
    expect(anchorCaret?.rowId).toBe(focusCaret?.rowId);
  });

  it("keeps a shift+right extension inside one cell within that cell", () => {
    // The snap is level-aware: both endpoints share the cell's slot, so the
    // selection stays a partial in-cell range instead of ballooning out.
    const latex = String.raw`\begin{bmatrix}ab&c\\d&e\end{bmatrix}`;
    let state = moveCursorToPosition(
      treeState(`$$\n${latex}\n$$`),
      0,
      latex.length,
    );
    state = insertText(state, "").state;
    const document = getMathStructuredDocument(block(state));
    if (!document) throw new Error("expected structured matrix");
    const cellStart = latex.indexOf("ab");
    const caret = mathContentSelectionFromSourceOffset(
      block(state).id,
      document.rootId,
      document,
      cellStart,
    );
    if (!caret) throw new Error("expected caret inside the cell");
    state = updateContentSelection(state, caret);

    const extended = state.actionBus.dispatchState(
      EXTEND_SELECTION_RIGHT,
      state,
    );
    expect(extended.claimed).toBe(true);
    const selection = extended.state.document.contentSelection;
    const after = getMathStructuredDocument(block(extended.state));
    if (!selection || !after) throw new Error("expected nested selection");
    expect(mathSourceRangeFromContentSelection(after, selection)).toEqual({
      from: cellStart,
      to: cellStart + 1,
    });
  });

  it("takes the matrix whole when shift+down crosses into another cell", () => {
    const latex = String.raw`\begin{bmatrix}a&b\\c&d\end{bmatrix}`;
    let state = moveCursorToPosition(
      treeState(`$$\n${latex}\n$$`),
      0,
      latex.length,
    );
    state = insertText(state, "").state;
    const document = getMathStructuredDocument(block(state));
    if (!document) throw new Error("expected structured matrix");
    const caret = mathContentSelectionFromSourceOffset(
      block(state).id,
      document.rootId,
      document,
      latex.indexOf("a"),
    );
    if (!caret) throw new Error("expected caret inside the first cell");
    state = updateContentSelection(state, caret);

    const extended = state.actionBus.dispatchState(
      EXTEND_SELECTION_DOWN,
      state,
    );
    expect(extended.claimed).toBe(true);
    const selection = extended.state.document.contentSelection;
    const after = getMathStructuredDocument(block(extended.state));
    if (!selection || !after) throw new Error("expected nested selection");
    expect(mathSourceRangeFromContentSelection(after, selection)).toEqual({
      from: 0,
      to: latex.length,
    });
  });

  it("snaps a raw committed range that half-covers the matrix", () => {
    // Gestures that combine two resolved points directly — shift+click, a
    // mouse drag, the public API — commit through updateContentSelection,
    // whose resolver facet must apply the same construct-atomic rule the
    // shift+arrow extension applies before committing.
    const latex = String.raw`x\begin{bmatrix}a&b\\c&d\end{bmatrix}`;
    let state = moveCursorToPosition(
      treeState(`$$\n${latex}\n$$`),
      0,
      latex.length,
    );
    state = insertText(state, "").state;
    const document = getMathStructuredDocument(block(state));
    if (!document) throw new Error("expected structured matrix");
    const anchor = mathContentSelectionFromSourceOffset(
      block(state).id,
      document.rootId,
      document,
      0,
    );
    const focus = mathContentSelectionFromSourceOffset(
      block(state).id,
      document.rootId,
      document,
      latex.indexOf("a&"),
    );
    if (!anchor || !focus) throw new Error("expected bridge carets");

    state = updateContentSelection(state, {
      anchor: anchor.focus,
      focus: focus.focus,
      lastUpdate: Date.now(),
    });
    const selection = state.document.contentSelection;
    const after = getMathStructuredDocument(block(state));
    if (!selection || !after) throw new Error("expected nested selection");
    expect(mathSourceRangeFromContentSelection(after, selection)).toEqual({
      from: 0,
      to: latex.length,
    });
    const anchorCaret = contentPointToMathTreeCaret(after, selection.anchor);
    const focusCaret = contentPointToMathTreeCaret(after, selection.focus);
    expect(anchorCaret?.rowId).toBe(focusCaret?.rowId);
  });

  it("resizes a matrix swept by a drag that starts before the construct", () => {
    // A mouse drag across the parentheses anchors a step or more before the
    // matrix (here: before the `x` sibling) and focuses past it, so neither
    // endpoint is adjacent to the construct. The range must still resolve it.
    const latex = String.raw`\frac{a}{b}x\begin{bmatrix}a&b\\c&d\end{bmatrix}`;
    let state = moveCursorToPosition(
      treeState(`$$\n${latex}\n$$`),
      0,
      latex.length,
    );
    state = insertText(state, "").state;
    const document = getMathStructuredDocument(block(state));
    if (!document) throw new Error("expected structured matrix");
    const blockId = block(state).id;
    const contentId = document.rootId;
    const anchor = mathContentSelectionFromSourceOffset(
      blockId,
      contentId,
      document,
      latex.indexOf("x"),
    );
    const focus = mathContentSelectionFromSourceOffset(
      blockId,
      contentId,
      document,
      latex.length,
    );
    if (!anchor || !focus) throw new Error("expected drag range");
    const selected = updateContentSelection(state, {
      anchor: anchor.focus,
      focus: focus.focus,
    });

    const resized = selected.actionBus.dispatchState(
      RESIZE_MATH_MATRIX,
      selected,
      { rows: 3, cols: 3 },
    );
    const resizedDocument = getMathStructuredDocument(block(resized.state));
    const math = resizedDocument
      ? structuredToMathDocument(resizedDocument)
      : undefined;
    const matrix = math?.root.body.children.find(
      (node) => node.type === "matrix",
    );
    expect(resized.claimed).toBe(true);
    expect(resized.ops.length).toBeGreaterThan(0);
    expect(matrix?.type).toBe("matrix");
    if (matrix?.type !== "matrix") throw new Error("expected matrix");
    expect(matrix.rows).toHaveLength(3);
    expect(matrix.rows.every((row) => row.cells.length === 3)).toBe(true);
  });

  it("types and arrow-navigates between matrix cells without editing LaTeX syntax", () => {
    const latex = String.raw`\begin{bmatrix}a&b\\c&d\end{bmatrix}`;
    let state = placeTreeCaret(
      treeState(`$$\n${latex}\n$$`),
      latex.indexOf("a&b") + 1,
    );

    state = insertText(state, "x").state;
    expect(treeSource(state)).toBe(
      String.raw`\begin{bmatrix}ax&b\\c&d\end{bmatrix}`,
    );
    expect(contentTextOffset(state)).toBe(2);

    state = { ...state, view: { ...state.view, isFocused: true } };
    const beforeRight = state.document.contentSelection;
    state = handleKeyDown(state, viewport, keydown("ArrowRight")).state;
    expect(state.document.contentSelection).not.toEqual(beforeRight);
    expect(state.document.contentSelection?.focus.kind).toBe("text");
    state = insertText(state, "y").state;
    expect(treeSource(state)).toBe(
      String.raw`\begin{bmatrix}ax&yb\\c&d\end{bmatrix}`,
    );

    const down = state.actionBus.dispatchState(MOVE_CURSOR_DOWN, state, {
      viewport,
    });
    expect(down.claimed).toBe(true);
    expect(down.state.document.contentSelection).not.toEqual(
      state.document.contentSelection,
    );
    const up = down.state.actionBus.dispatchState(MOVE_CURSOR_UP, down.state, {
      viewport,
    });
    expect(up.claimed).toBe(true);
    expect(up.state.document.contentSelection).not.toEqual(
      down.state.document.contentSelection,
    );
    expect(treeSource(up.state)).toBe(treeSource(state));
  });

  it("ArrowRight advances between empty matrix cells after a fraction", () => {
    const latex = String.raw`\frac{a}{b}\begin{pmatrix}&{}\\{}&{}\end{pmatrix}`;
    let state = moveCursorToPosition(
      treeState(`$$\n${latex}\n$$`),
      0,
      "\\frac{a}{b}".length,
    );
    state = insertText(state, "").state;
    const document = getMathStructuredDocument(block(state));
    const math = document ? structuredToMathDocument(document) : undefined;
    const matrix = math?.root.body.children[1];
    if (!document || matrix?.type !== "matrix") {
      throw new Error("expected structured matrix");
    }
    const afterFraction = mathContentSelectionFromSourceOffset(
      block(state).id,
      document.rootId,
      document,
      String.raw`\frac{a}{b}`.length,
    );
    if (!afterFraction) throw new Error("expected fraction boundary caret");
    state = updateContentSelection(state, afterFraction);

    state = { ...state, view: { ...state.view, isFocused: true } };
    const first = handleKeyDown(state, viewport, keydown("ArrowRight")).state;
    const second = handleKeyDown(first, viewport, keydown("ArrowRight")).state;

    expect(first.document.contentSelection?.focus).toMatchObject({
      kind: "gap",
      parentId: matrix.rows[0].cells[0].body.id,
    });
    expect(second.document.contentSelection?.focus).toMatchObject({
      kind: "gap",
      parentId: matrix.rows[0].cells[1].body.id,
    });
    const layout = layoutMathDocument(math);
    const firstStop = mathDocumentCaretStop(layout, {
      kind: "row",
      rowId: matrix.rows[0].cells[0].body.id,
      offset: 0,
    });
    const secondStop = mathDocumentCaretStop(layout, {
      kind: "row",
      rowId: matrix.rows[0].cells[1].body.id,
      offset: 0,
    });
    expect(secondStop?.x).toBeGreaterThan(firstStop?.x ?? 0);
  });

  it("ArrowUp exits the top of a structured display equation", () => {
    let state = typeText(treeState("$$\n\n$$"), "x").state;
    state = { ...state, view: { ...state.view, isFocused: true } };

    const result = handleKeyDown(state, viewport, keydown("ArrowUp"));

    expect(result.ops.map((op) => op.op)).toEqual(["block_insert"]);
    expect(result.state.document.page.blocks.map((item) => item.type)).toEqual([
      "paragraph",
      "math",
    ]);
    expect(result.state.document.contentSelection).toBeNull();
    expect(result.state.document.cursor?.position).toEqual({
      blockIndex: 0,
      textIndex: 0,
    });
  });

  it("ArrowUp leaves structured math for the preceding text block", () => {
    let state = treeState("intro\n\n$$\nx\n$$");
    const paragraph = state.document.page.blocks.find(
      (item) => item.type === "paragraph",
    )!;
    const math = state.document.page.blocks.find(
      (item) => item.type === "math",
    )!;
    state = {
      ...state,
      document: {
        ...state.document,
        page: { ...state.document.page, blocks: [paragraph, math] },
      },
    };
    state = moveCursorToPosition(state, 1, 1);
    state = insertText(state, "y").state;
    state = { ...state, view: { ...state.view, isFocused: true } };

    expect(state.document.contentSelection).not.toBeNull();

    const result = handleKeyDown(state, viewport, keydown("ArrowUp"));

    expect(result.ops).toEqual([]);
    expect(result.state.document.contentSelection).toBeNull();
    expect(result.state.document.cursor?.position).toEqual({
      blockIndex: 0,
      textIndex: "intro".length,
    });
  });

  it("keeps a display matrix structured while a backslash is pending in a cell", () => {
    const latex = String.raw`\begin{bmatrix}a&b\\c&d\end{bmatrix}`;
    const entered = placeTreeCaret(
      treeState(`$$\n${latex}\n$$`),
      latex.indexOf("a&b") + 1,
    );

    const typed = insertText(entered, "\\").state;

    expect(treeSource(typed)).toBe(
      String.raw`\begin{bmatrix}a\backslash&b\\c&d\end{bmatrix}`,
    );
    const document = getMathStructuredDocument(block(typed));
    const math = document ? structuredToMathDocument(document) : undefined;
    const matrix = math?.root.body.children.find(
      (node) => node.type === "matrix",
    );
    expect(matrix?.type).toBe("matrix");
    if (matrix?.type !== "matrix") return;
    expect(matrix.rows.map((row) => row.cells.length)).toEqual([2, 2]);
  });

  it("stores two typed backslashes as a symbol node inside the current matrix-cell node", () => {
    const latex = String.raw`\begin{bmatrix}a&b\\c&d\end{bmatrix}`;
    let state = placeTreeCaret(
      treeState(`$$\n${latex}\n$$`),
      latex.indexOf("a&b") + 1,
    );
    // Capture the identity-bearing cells after the first backslash commits,
    // then verify the second only inserts a child within the active cell.
    state = insertText(state, "\\").state;
    const beforeDocument = getMathStructuredDocument(block(state));
    const beforeMath = beforeDocument
      ? structuredToMathDocument(beforeDocument)
      : undefined;
    const beforeMatrix = beforeMath?.root.body.children.find(
      (node) => node.type === "matrix",
    );
    if (beforeMatrix?.type !== "matrix") throw new Error("expected matrix");
    const cellIds = beforeMatrix.rows.flatMap((row) =>
      row.cells.map((cell) => cell.id),
    );

    state = insertText(state, "\\").state;

    expect(treeSource(state)).toBe(
      String.raw`\begin{bmatrix}a\backslash&b\\c&d\end{bmatrix}`,
    );
    const afterDocument = getMathStructuredDocument(block(state));
    const afterMath = afterDocument
      ? structuredToMathDocument(afterDocument)
      : undefined;
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

  it("converges when peer matrix resize batches arrive in opposite orders", () => {
    const latex = String.raw`\begin{bmatrix}a&b\\c&d\end{bmatrix}`;
    const seeded = placeTreeCaret(
      treeState(
        `$$\n${latex}\n$$`,
        createCRDTbinding("matrix-resize-convergence", "seed"),
      ),
      latex.indexOf("a&b") + 1,
    );
    const selection = seeded.document.contentSelection;
    if (!selection) throw new Error("expected a matrix cell selection");
    const basePage = seeded.document.page;

    const peerState = (peerId: string): EditorState =>
      updateContentSelection(
        stateFromPage(
          basePage,
          createCRDTbinding("matrix-resize-convergence", peerId),
        ),
        selection,
      );
    const rowsState = peerState("rows-peer");
    const rowsPeer = rowsState.actionBus.dispatchState(
      RESIZE_MATH_MATRIX,
      rowsState,
      { rows: 3, cols: 2 },
    );
    const columnsState = peerState("columns-peer");
    const columnsPeer = columnsState.actionBus.dispatchState(
      RESIZE_MATH_MATRIX,
      columnsState,
      { rows: 2, cols: 3 },
    );

    expect(rowsPeer.ops.length).toBeGreaterThan(0);
    expect(columnsPeer.ops.length).toBeGreaterThan(0);
    const rowsThenColumns = applyOps(
      applyOps(basePage, rowsPeer.ops, treeMathSchema.data),
      columnsPeer.ops,
      treeMathSchema.data,
    );
    const columnsThenRows = applyOps(
      applyOps(basePage, columnsPeer.ops, treeMathSchema.data),
      rowsPeer.ops,
      treeMathSchema.data,
    );

    expect(rowsThenColumns).toEqual(columnsThenRows);
    expect(getStructuredMathSource(rowsThenColumns.blocks[0])).toBe(
      getStructuredMathSource(columnsThenRows.blocks[0]),
    );
  });

  it("completes a literal \\frac into a structural fraction", () => {
    const typed = typeText(treeState("$$\n\n$$"), String.raw`\frac`);
    const current = block(typed.state);
    const document = getMathStructuredDocument(current);
    const math = document ? structuredToMathDocument(document) : undefined;
    const fraction = math?.root.body.children[0];
    if (!fraction || fraction.type !== "fraction") {
      throw new Error("expected one structural fraction");
    }

    expect(treeSource(typed.state)).toBe(String.raw`\frac{}{}`);
    expect(operationKinds(typed.lastOps)).toEqual([
      "content:text_insert",
      "content:text_delete",
      "content:node_delete",
      "content:node_insert",
      "content:node_insert",
      "content:node_insert",
    ]);
    expect(typed.state.document.contentSelection?.focus).toMatchObject({
      kind: "gap",
      parentId: fraction.numerator.id,
      afterNodeId: null,
    });

    const unknown = typeText(treeState("$$\n\n$$"), String.raw`\wat`).state;
    expect(treeSource(unknown)).toBe(String.raw`\wat`);
  });

  it("completes a manually typed square root semantically and deletes it whole", () => {
    const typed = typeText(treeState("$$\n\n$$"), String.raw`\sqrt`).state;
    const document = getMathStructuredDocument(block(typed));
    const math = document ? structuredToMathDocument(document) : undefined;

    expect(math?.root.body.children[0]?.type).toBe("radical");
    expect(treeSource(typed)).toBe(String.raw`\sqrt{}`);
    expect(
      Object.values(document?.nodes ?? {}).some(
        (node) =>
          node.type === "raw-text" &&
          getVisibleTextFromRuns(node.textFields.text).includes(
            String.raw`\sqrt`,
          ),
      ),
    ).toBe(false);

    const deleted = typed.actionBus.dispatchState(DELETE_BACKWARD, typed);
    expect(deleted.claimed).toBe(true);
    expect(treeSource(deleted.state)).toBe("");
  });

  it("completes unambiguous manual symbols and scripted operators", () => {
    const symbolState = typeText(
      treeState("$$\n\n$$"),
      String.raw`\alpha`,
    ).state;
    const symbolDocument = getMathStructuredDocument(block(symbolState));
    const symbolMath = symbolDocument
      ? structuredToMathDocument(symbolDocument)
      : undefined;
    expect(symbolMath?.root.body.children[0]?.type).toBe("symbol");
    expect(treeSource(symbolState)).toBe(String.raw`\alpha`);

    const operatorState = typeText(
      treeState("$$\n\n$$"),
      String.raw`\sum`,
    ).state;
    const operatorDocument = getMathStructuredDocument(block(operatorState));
    const operatorMath = operatorDocument
      ? structuredToMathDocument(operatorDocument)
      : undefined;
    const scripts = operatorMath?.root.body.children[0];
    expect(scripts?.type).toBe("scripts");
    if (scripts?.type !== "scripts") throw new Error("expected scripts");
    expect(scripts.base.children[0]?.type).toBe("symbol");
    expect(scripts.base.children[0]).toMatchObject({ symbolClass: "op" });
  });

  it("navigates fraction slots and unwraps an empty denominator", () => {
    let state = typeText(treeState("$$\n\n$$"), String.raw`\frac`).state;
    state = typeText(state, "a").state;

    const document = getMathStructuredDocument(block(state));
    const math = document ? structuredToMathDocument(document) : undefined;
    const fraction = math?.root.body.children[0];
    if (!fraction || fraction.type !== "fraction") {
      throw new Error("expected one structural fraction");
    }

    const tabbed = state.actionBus.dispatchState(MOVE_CONTENT_TAB, state, {
      backward: false,
    });
    expect(tabbed.claimed).toBe(true);
    expect(tabbed.ops).toEqual([]);
    expect(tabbed.state.document.contentSelection?.focus).toMatchObject({
      kind: "gap",
      parentId: fraction.denominator.id,
    });

    const shiftedBack = tabbed.state.actionBus.dispatchState(
      MOVE_CONTENT_TAB,
      tabbed.state,
      { backward: true },
    );
    expect(shiftedBack.state.document.contentSelection?.focus.kind).toBe(
      "text",
    );
    expect(contentTextOffset(shiftedBack.state)).toBe(1);

    const right = shiftedBack.state.actionBus.dispatchState(
      MOVE_CURSOR_RIGHT,
      shiftedBack.state,
    );
    expect(right.state.document.contentSelection?.focus).toMatchObject({
      kind: "gap",
      parentId: fraction.denominator.id,
    });

    const unwrapped = right.state.actionBus.dispatchState(
      DELETE_BACKWARD,
      right.state,
    );
    expect(unwrapped.claimed).toBe(true);
    expect(operationKinds(unwrapped.ops)).toEqual([
      "content:node_move",
      "content:node_delete",
    ]);
    expect(treeSource(unwrapped.state)).toBe("a");
  });

  it("continues horizontal navigation into adjacent document blocks", () => {
    let state = placeTreeCaret(treeState("$$\nxy\n$$"), 2);
    const surrounding = loadPage("before\n\nafter", treeMathSchema.data);
    const before = { ...surrounding.blocks[0], id: "nav-before" };
    const after = { ...surrounding.blocks[1], id: "nav-after" };
    state = {
      ...state,
      document: {
        ...state.document,
        page: {
          ...state.document.page,
          blocks: [before, state.document.page.blocks[0], after],
        },
      },
    };

    const right = state.actionBus.dispatchState(MOVE_CURSOR_RIGHT, state);
    expect(right.claimed).toBe(true);
    expect(right.state.document.contentSelection).toBeNull();
    expect(right.state.document.cursor?.position).toEqual({
      blockIndex: 2,
      textIndex: 0,
    });

    let leftState = state;
    for (
      let step = 0;
      step < 4 && leftState.document.contentSelection;
      step++
    ) {
      leftState = leftState.actionBus.dispatchState(
        MOVE_CURSOR_LEFT,
        leftState,
      ).state;
    }
    expect(leftState.document.contentSelection).toBeNull();
    expect(leftState.document.cursor?.position).toEqual({
      blockIndex: 0,
      textIndex: 6,
    });
  });

  it("creates an outside caret stop at a terminal display-math edge", () => {
    const state = placeTreeCaret(treeState("$$\nxy\n$$"), 2);
    const right = state.actionBus.dispatchState(MOVE_CURSOR_RIGHT, state);

    expect(right.claimed).toBe(true);
    expect(right.ops).toHaveLength(1);
    expect(right.ops[0]).toMatchObject({
      op: "block_insert",
      blockType: "paragraph",
    });
    expect(right.state.document.contentSelection).toBeNull();
    expect(right.state.document.page.blocks.map((entry) => entry.type)).toEqual(
      ["math", "paragraph"],
    );
    expect(right.state.document.cursor?.position).toEqual({
      blockIndex: 1,
      textIndex: 0,
    });

    const next = right.state.actionBus.dispatchState(
      MOVE_CURSOR_RIGHT,
      right.state,
    );
    expect(next.state.document.contentSelection).toBeNull();
    expect(next.state.document.cursor?.position.blockIndex).toBe(1);
  });

  it("converges when two peers edit the same imported equation concurrently", () => {
    const pageId = "math-tree-convergence";
    const seed = createCRDTbinding(pageId, "seed");
    const initial = loadPage("$$\nab\n$$", treeMathSchema.data);
    const baseOps = blocksToOps(initial.blocks, {
      pageId,
      peerId: seed.getPeerId(),
      nextId: seed.nextId,
      getClock: seed.getClock,
      schema: treeMathSchema.data,
    });

    const bindingA = createCRDTbinding(pageId, "peer-a");
    const bindingB = createCRDTbinding(pageId, "peer-b");
    const engineA = createSyncEngine(bindingA, treeMathSchema.data);
    const engineB = createSyncEngine(bindingB, treeMathSchema.data);
    engineA.loadOperations(baseOps);
    engineB.loadOperations(baseOps);

    // Editor states over clones: mounting a state annotates blocks in place
    // (layout caches), and the engines' snapshots must stay pristine so the
    // final comparison sees only CRDT-derived data.
    const editA = insertText(
      placeTreeCaret(
        stateFromPage(structuredClone(engineA.getState()), bindingA),
        2,
      ),
      "c",
    );
    const editB = insertText(
      placeTreeCaret(
        stateFromPage(structuredClone(engineB.getState()), bindingB),
        2,
      ),
      "d",
    );
    engineA.emit(editA.ops);
    engineB.emit(editB.ops);
    engineA.apply(editB.ops);
    engineB.apply(editA.ops);

    expect(engineA.getState()).toEqual(engineB.getState());
    const sourceA = getStructuredMathSource(engineA.getState().blocks[0]);
    const sourceB = getStructuredMathSource(engineB.getState().blocks[0]);
    expect(sourceA).toBe(sourceB);
    expect(sourceA).toContain("c");
    expect(sourceA).toContain("d");
  });
});

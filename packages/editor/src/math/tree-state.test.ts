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
  EXTEND_SELECTION_LEFT,
  EXTEND_SELECTION_RIGHT,
  MOVE_CONTENT_TAB,
  MOVE_CURSOR_DOWN,
  MOVE_CURSOR_LEFT,
  MOVE_CURSOR_RIGHT,
  MOVE_CURSOR_UP,
} from "../actions/keyboard-actions";
import { handleKeyDown } from "../events/keysEvents";
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
import { insertCharsAtPosition } from "../sync/crdt-utils";
import { extractCounter } from "../sync/id";
import { applyOps } from "../sync/reducer";
import { blocksToOps } from "../sync/snapshot-diff";
import { applyStructuredEdits } from "../sync/structured-content";
import {
  createCRDTbinding,
  createSyncEngine,
  maxStructuredDocumentIdCounter,
} from "../sync/sync";
import {
  getMathStructuredDocument,
  getStructuredMathSource,
  structuredToMathDocument,
} from "./structured";
import { mathContentSelectionFromSourceOffset } from "./tree-selection";
import { deleteActiveMathTreeSelection } from "./tree-state";
import {
  isValidLatex,
  layoutMathDocument,
  mathDocumentCaretStop,
} from "@cypherkit/tex";
import { describe, expect, it } from "vitest";

const treeMathSchema = baseSchema.use(
  mathExtension({ displayEditing: "tree" }),
);
const legacyMathSchema = baseSchema.use(mathExtension());

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

function legacyStateFromPage(
  page: ReturnType<typeof loadPage>,
  binding: ReturnType<typeof createCRDTbinding>,
): EditorState {
  return createInitialState(page, {
    schema: legacyMathSchema.data,
    nodes: createNodeRegistry(legacyMathSchema.nodes),
    marks: createMarkRegistry(legacyMathSchema.marks),
    crdtBinding: binding,
  });
}

function placeAtLegacyEnd(state: EditorState): EditorState {
  const block = state.document.page.blocks[0];
  const length =
    "charRuns" in block ? getVisibleTextFromRuns(block.charRuns).length : 0;
  return moveCursorToPosition(state, 0, length);
}

function typeText(
  state: EditorState,
  text: string,
): { state: EditorState; lastOps: Operation[] } {
  if (!state.document.cursor && !state.document.contentSelection) {
    state = placeAtLegacyEnd(state);
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

function withCompatibilitySource(
  state: EditorState,
  source: string,
): EditorState {
  const inserted = insertCharsAtPosition(
    state.document.page,
    block(state).id,
    0,
    source,
    state.CRDTbinding,
  );
  return {
    ...state,
    document: { ...state.document, page: inserted.newPage },
  };
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
    const attachment = converted.structuredContent?.[original.rootId];

    expect(result.claimed).toBe(true);
    expect(operationKinds(result.ops)).toEqual([
      "block_set",
      "content:document_delete",
      "content:document_init",
      "text_insert",
      "mark_set",
    ]);
    expect(converted.type).toBe("paragraph");
    expect(attachment?.authority).toBeUndefined();
    expect(attachment?.nodes).toEqual(original.nodes);
    expect(
      serializeToMarkdown(result.state.document.page.blocks, undefined, {
        schema: result.state.schema,
      }),
    ).toBe("$ab$");
    expect(result.state.document.contentSelection).toBeNull();
    expect(result.state.document.cursor?.position).toEqual({
      blockIndex: 0,
      textIndex: 2,
    });
  });

  it("emits a nested TEXT_INPUT signal when a tree consumes backslash", () => {
    let state = placeAtLegacyEnd(treeState("$$\n\n$$"));
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

    expect(treeSource(typed)).toBe("\\");
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

  it("keeps an existing tree authoritative in legacy migration mode", () => {
    const seeded = typeText(treeState("$$\n\n$$"), "ab").state;
    let state = legacyStateFromPage(seeded.document.page, seeded.CRDTbinding);
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

  it("does not fall through to compatibility text for a flat tree selection", () => {
    let state = typeText(treeState("$$\n\n$$"), "x").state;
    state = withCompatibilitySource(state, "stale");
    state = moveCursorToPosition(state, 0, 1);
    state = updateSelection(state, {
      anchor: { blockIndex: 0, textIndex: 0 },
      focus: { blockIndex: 0, textIndex: 1 },
    });

    const result = insertText(state, "z");

    expect(result.ops).toEqual([]);
    expect(treeSource(result.state)).toBe("x");
    expect(legacySource(result.state)).toBe("stale");
    expect(result.state.document.selection?.isCollapsed).toBe(false);
  });

  it("cleans stale visible compatibility chars on the next tree mutation", () => {
    let state = typeText(treeState("$$\n\n$$"), "x").state;
    state = withCompatibilitySource(state, "stale");

    const left = state.actionBus.dispatchState(MOVE_CURSOR_LEFT, state);
    expect(left.ops).toEqual([]);
    const navigated = left.state.actionBus.dispatchState(
      MOVE_CURSOR_RIGHT,
      left.state,
    );
    expect(navigated.ops).toEqual([]);
    expect(legacySource(navigated.state)).toBe("stale");

    const result = insertText(navigated.state, "y");

    expect(operationKinds(result.ops)).toEqual([
      "text_delete",
      "content:text_insert",
    ]);
    expect(legacySource(result.state)).toBe("");
    expect(treeSource(result.state)).toBe("xy");
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

  it("migrates and splices a semantic command at an interior legacy caret", () => {
    const before = moveCursorToPosition(treeState("$$\nab\n$$"), 0, 1);
    const result = before.actionBus.dispatchState(INSERT_MATH_COMMAND, before, {
      text: String.raw`\sqrt{}`,
      caretOffset: 6,
    });

    expect(result.claimed).toBe(true);
    expect(legacySource(result.state)).toBe("");
    expect(treeSource(result.state)).toBe(String.raw`a\sqrt{}b`);
    expect(operationKinds(result.ops)).toEqual([
      "content:document_init",
      "text_delete",
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
    const before = placeAtLegacyEnd(treeState("$$\n\n$$"));
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
      const before = placeAtLegacyEnd(treeState("$$\n\n$$"));
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
    const before = placeAtLegacyEnd(treeState("$$\n\n$$"));
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
      placeAtLegacyEnd(treeState("$$\n\n$$")),
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
      placeAtLegacyEnd(treeState("$$\n\n$$")),
      "😀",
    ).state;
    expect(treeSource(inserted)).toBe("😀");
  });

  it.each([
    ["^", "scripts"],
    ["_", "scripts"],
    ["{", "symbol"],
    ["}", "symbol"],
    ["&", "symbol"],
  ])("keeps structural key %s out of raw-text", (input, nodeType) => {
    const inserted = insertText(
      placeAtLegacyEnd(treeState("$$\n\n$$")),
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

  it("lazily migrates legacy source and makes the tree authoritative", () => {
    let before = treeState("$$\nab\n$$");
    before = placeAtLegacyEnd(before);

    const result = insertText(before, "c");

    expect(operationKinds(result.ops)).toEqual([
      "content:document_init",
      "text_delete",
      "content:text_insert",
    ]);
    expect(legacySource(result.state)).toBe("");
    expect(treeSource(result.state)).toBe("abc");
    expect(result.state.document.cursor).toBeNull();
    expect(result.state.document.contentSelection?.focus.kind).toBe("text");
    expect(contentTextOffset(result.state)).toBe(3);

    const init = result.ops.find(
      (op) => op.op === "content_edit" && op.edit.kind === "document_init",
    );
    const inserted = result.ops.find(
      (op) => op.op === "content_edit" && op.edit.kind === "text_insert",
    );
    if (
      !init ||
      init.op !== "content_edit" ||
      init.edit.kind !== "document_init" ||
      !inserted ||
      inserted.op !== "content_edit" ||
      inserted.edit.kind !== "text_insert"
    ) {
      throw new Error("expected migration and tree insertion operations");
    }
    expect(inserted.edit.charRuns[0].startCounter).toBeGreaterThan(
      maxStructuredDocumentIdCounter(init.edit.document),
    );
    expect(extractCounter(inserted.id)).toBeGreaterThan(
      inserted.edit.charRuns[0].startCounter,
    );

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

  it("migrates legacy source before backward and forward deletion", () => {
    for (const [action, offset] of [
      [DELETE_BACKWARD, 2],
      [DELETE_FORWARD, 1],
    ] as const) {
      const before = moveCursorToPosition(treeState("$$\nabc\n$$"), 0, offset);
      const result = before.actionBus.dispatchState(action, before);

      expect(result.claimed).toBe(true);
      expect(operationKinds(result.ops)).toEqual([
        "content:document_init",
        "text_delete",
        "content:text_delete",
      ]);
      expect(legacySource(result.state)).toBe("");
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
      const before = moveCursorToPosition(
        treeState(`$$\n${source}\n$$`),
        0,
        offset,
      );

      const selected = before.actionBus.dispatchState(action, before);
      expect(selected.claimed).toBe(true);
      expect(treeSource(selected.state)).toBe(source);
      expect(selected.state.document.contentSelection?.anchor).not.toEqual(
        selected.state.document.contentSelection?.focus,
      );

      const deleted = selected.state.actionBus.dispatchState(
        action,
        selected.state,
      );
      expect(treeSource(deleted.state)).toBe("");
    },
  );

  it("migrates a legacy same-block range before deleting it", () => {
    let before = moveCursorToPosition(treeState("$$\nabcd\n$$"), 0, 3);
    before = updateSelection(before, {
      anchor: { blockIndex: 0, textIndex: 1 },
      focus: { blockIndex: 0, textIndex: 3 },
    });

    const result = before.actionBus.dispatchState(DELETE_BACKWARD, before);

    expect(result.claimed).toBe(true);
    expect(operationKinds(result.ops)).toEqual([
      "content:document_init",
      "text_delete",
      "content:text_delete",
    ]);
    expect(legacySource(result.state)).toBe("");
    expect(treeSource(result.state)).toBe("ad");
    expect(contentTextOffset(result.state)).toBe(1);
  });

  it("routes the native cut action through legacy tree migration", () => {
    let before = moveCursorToPosition(treeState("$$\nabcd\n$$"), 0, 3);
    before = updateSelection(before, {
      anchor: { blockIndex: 0, textIndex: 1 },
      focus: { blockIndex: 0, textIndex: 3 },
    });

    const result = before.actionBus.dispatchState(CUT, before);

    expect(result.claimed).toBe(false);
    expect(operationKinds(result.ops)).toEqual([
      "content:document_init",
      "text_delete",
      "content:text_delete",
    ]);
    expect(legacySource(result.state)).toBe("");
    expect(treeSource(result.state)).toBe("ad");
  });

  it("routes async public cut through legacy tree migration", async () => {
    let before = moveCursorToPosition(treeState("$$\nabcd\n$$"), 0, 3);
    before = updateSelection(before, {
      anchor: { blockIndex: 0, textIndex: 1 },
      focus: { blockIndex: 0, textIndex: 3 },
    });
    const clipboard: HostClipboard = {
      write: async () => {},
      read: async () => ({}),
    };

    const cut = await cutSelectionToClipboard(before, clipboard);

    expect(cut.success).toBe(true);
    expect(cut.result).not.toBeNull();
    expect(operationKinds(cut.result!.ops)).toEqual([
      "content:document_init",
      "text_delete",
      "content:text_delete",
    ]);
    expect(legacySource(cut.result!.state)).toBe("");
    expect(treeSource(cut.result!.state)).toBe("ad");
  });

  it("keeps a legacy range intact until IME commit migrates it", () => {
    let before = moveCursorToPosition(treeState("$$\nabcd\n$$"), 0, 3);
    before = updateSelection(before, {
      anchor: { blockIndex: 0, textIndex: 1 },
      focus: { blockIndex: 0, textIndex: 3 },
    });

    const started = before.actionBus.dispatchState(COMPOSITION_START, before, {
      data: "あ",
    });
    expect(started.ops).toEqual([]);
    expect(legacySource(started.state)).toBe("abcd");
    expect(getMathStructuredDocument(block(started.state))).toBeUndefined();

    const committed = started.state.actionBus.dispatchState(
      COMPOSITION_END,
      started.state,
      { data: "あ" },
    );
    expect(legacySource(committed.state)).toBe("");
    expect(treeSource(committed.state)).toBe("aあd");
    expect(
      committed.ops.some(
        (op) => op.op === "content_edit" && op.edit.kind === "document_init",
      ),
    ).toBe(true);
  });

  it("prefers plain clipboard text through migration over rich flat paste", () => {
    const before = moveCursorToPosition(treeState("$$\nabcd\n$$"), 0, 2);
    const pasted = pasteFromClipboardEvent(before, {} as ClipboardEvent, {
      html: "<p><strong>wrong-rich-surface</strong></p>",
      text: "X",
      imageFile: null,
    });

    expect(pasted).not.toBeNull();
    expect(operationKinds(pasted!.ops)).toEqual([
      "content:document_init",
      "text_delete",
      "content:text_insert",
    ]);
    expect(legacySource(pasted!.state)).toBe("");
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

  it("routes host-system plain paste through migration", async () => {
    const before = moveCursorToPosition(treeState("$$\nabcd\n$$"), 0, 2);
    const clipboard: HostClipboard = {
      write: async () => {},
      read: async () => ({
        html: "<p><strong>wrong-rich-surface</strong></p>",
        text: "Y",
      }),
    };

    const pasted = await pasteFromSystemClipboard(before, clipboard);

    expect(pasted).not.toBeNull();
    expect(legacySource(pasted!.state)).toBe("");
    expect(treeSource(pasted!.state)).toBe("abYcd");
    expect(pasted!.ops.some((op) => op.op === "content_edit")).toBe(true);
  });

  it("keeps legacy cross-block replacement on the flat document path", () => {
    const makeRange = () => {
      let state = moveCursorToPosition(
        treeState("$$\nabc\n$$\n\noutside"),
        1,
        2,
      );
      const outsideIndex = state.document.page.blocks.findIndex(
        (candidate) =>
          "charRuns" in candidate &&
          getVisibleTextFromRuns(candidate.charRuns) === "outside",
      );
      state = updateSelection(state, {
        anchor: { blockIndex: 0, textIndex: 2 },
        focus: { blockIndex: outsideIndex, textIndex: 2 },
      });
      return state;
    };

    for (const [mutate, expected] of [
      [
        (state: EditorState) =>
          state.actionBus.dispatchState(DELETE_BACKWARD, state),
        "$$\nabtside\n$$",
      ],
      [
        (state: EditorState) =>
          state.actionBus.dispatchState(DELETE_FORWARD, state),
        "$$\nabtside\n$$",
      ],
      [(state: EditorState) => insertText(state, "X"), "$$\nabXtside\n$$"],
    ] as const) {
      const before = makeRange();
      const result = mutate(before);
      expect(result.ops.length).toBeGreaterThan(0);
      expect(
        serializeToMarkdown(result.state.document.page.blocks, undefined, {
          schema: result.state.schema,
        }),
      ).toBe(expected);
      expect(getMathStructuredDocument(block(result.state))).toBeUndefined();
    }
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

  it("keeps word deletion on the tree authority boundary", () => {
    for (const [action, offset, expected] of [
      [DELETE_WORD_BACKWARD, 3, "ab"],
      [DELETE_WORD_FORWARD, 0, "bc"],
    ] as const) {
      const before = moveCursorToPosition(treeState("$$\nabc\n$$"), 0, offset);
      const result = before.actionBus.dispatchState(action, before);

      expect(result.claimed).toBe(true);
      expect(operationKinds(result.ops)).toEqual([
        "content:document_init",
        "text_delete",
        "content:text_delete",
      ]);
      expect(legacySource(result.state)).toBe("");
      expect(treeSource(result.state)).toBe(expected);
    }
  });

  it("commits migration when deletion has no structural target", () => {
    const before = moveCursorToPosition(treeState("$$\nabc\n$$"), 0, 0);
    const result = before.actionBus.dispatchState(DELETE_BACKWARD, before);

    expect(result.claimed).toBe(true);
    expect(operationKinds(result.ops)).toEqual([
      "content:document_init",
      "text_delete",
    ]);
    expect(legacySource(result.state)).toBe("");
    expect(treeSource(result.state)).toBe("abc");
    expect(contentTextOffset(result.state)).toBe(0);
  });

  it("preserves flat deletion when the schema explicitly uses legacy mode", () => {
    let before = legacyStateFromPage(
      loadPage("$$\nabc\n$$", legacyMathSchema.data),
      createCRDTbinding("default-page", "legacy-delete"),
    );
    before = moveCursorToPosition(before, 0, 3);

    const result = before.actionBus.dispatchState(DELETE_BACKWARD, before);

    expect(operationKinds(result.ops)).toEqual(["text_delete"]);
    expect(legacySource(result.state)).toBe("ab");
    expect(treeSource(result.state)).toBeUndefined();
    expect(result.state.document.cursor?.position.textIndex).toBe(2);

    const pasted = pasteFromClipboardEvent(
      moveCursorToPosition(
        legacyStateFromPage(
          loadPage("$$\nabcd\n$$", legacyMathSchema.data),
          createCRDTbinding("default-page", "legacy-paste"),
        ),
        0,
        2,
      ),
      {} as ClipboardEvent,
      { html: "", text: "X", imageFile: null },
    );
    expect(pasted).not.toBeNull();
    expect(legacySource(pasted!.state)).toBe("abXcd");
    expect(treeSource(pasted!.state)).toBeUndefined();
  });

  it("resizes a structured matrix through the public action and undoes it", () => {
    const latex = String.raw`\begin{bmatrix}a&b\\c&d\end{bmatrix}`;
    let before = moveCursorToPosition(
      treeState(`$$\n${latex}\n$$`),
      latex.indexOf("a&b"),
      latex.indexOf("a&b"),
    );
    before = insertText(before, "").state;
    expect(getMathStructuredDocument(block(before))).toBeDefined();

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

  it("types and arrow-navigates between matrix cells without editing LaTeX syntax", () => {
    const latex = String.raw`\begin{bmatrix}a&b\\c&d\end{bmatrix}`;
    let state = moveCursorToPosition(
      treeState(`$$\n${latex}\n$$`),
      0,
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

  it("ArrowRight advances through a newly loaded legacy matrix", () => {
    const latex = String.raw`\frac{a}{b}\begin{pmatrix}&{}\\{}&{}\end{pmatrix}`;
    let state = moveCursorToPosition(
      treeState(`$$\n${latex}\n$$`),
      0,
      String.raw`\frac{a}{b}`.length,
    );
    state = { ...state, view: { ...state.view, isFocused: true } };

    const first = handleKeyDown(state, viewport, keydown("ArrowRight")).state;
    const second = handleKeyDown(first, viewport, keydown("ArrowRight")).state;

    expect(first.document.cursor?.position.textIndex).toBe(26);
    expect(second.document.cursor?.position.textIndex).toBe(28);
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
    const entered = moveCursorToPosition(
      treeState(`$$\n${latex}\n$$`),
      0,
      latex.indexOf("a&b") + 1,
    );

    const typed = insertText(entered, "\\").state;

    expect(treeSource(typed)).toBe(
      String.raw`\begin{bmatrix}a\ &b\\c&d\end{bmatrix}`,
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
    let state = moveCursorToPosition(
      treeState(`$$\n${latex}\n$$`),
      0,
      latex.indexOf("a&b") + 1,
    );
    // The first edit performs the lazy legacy-source -> structured-tree
    // migration. Capture the identity-bearing cells after that boundary, then
    // verify the second backslash only inserts a child within the active cell.
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
    let legacy = moveCursorToPosition(
      treeState(
        `$$\n${latex}\n$$`,
        createCRDTbinding("matrix-resize-convergence", "seed"),
      ),
      0,
      latex.indexOf("a&b"),
    );
    legacy = insertText(legacy, "").state;
    const selection = legacy.document.contentSelection;
    if (!selection) throw new Error("expected a migrated matrix selection");
    const basePage = legacy.document.page;

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
    let state = typeText(treeState("$$\nx\n$$"), "y").state;
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
      step < 3 && leftState.document.contentSelection;
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
    const state = typeText(treeState("$$\nx\n$$"), "y").state;
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

  it("undoes the first user edit while keeping tree initialization monotonic", () => {
    let before = treeState("$$\nab\n$$");
    before = placeAtLegacyEnd(before);
    const typed = insertText(before, "c");
    const recorded = recordUndoOps(
      before,
      typed.state,
      typed.ops,
      before.CRDTbinding.getPeerId(),
    );

    const undone = undoState(recorded).state;
    expect(getMathStructuredDocument(block(undone))).toBeDefined();
    expect(treeSource(undone)).toBe("ab");
    expect(legacySource(undone)).toBe("ab");
    expect(undone.document.contentSelection).toBeNull();
    expect(undone.document.cursor?.position).toEqual({
      blockIndex: 0,
      textIndex: 2,
    });

    const redone = redoState(undone).state;
    expect(legacySource(redone)).toBe("");
    expect(treeSource(redone)).toBe("abc");
    expect(redone.document.cursor).toBeNull();
    expect(redone.document.contentSelection?.focus.kind).toBe("text");
    expect(contentTextOffset(redone)).toBe(3);
  });

  it("converges when two peers lazily migrate and edit the same equation", () => {
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

    const editA = insertText(
      placeAtLegacyEnd(stateFromPage(engineA.getState(), bindingA)),
      "c",
    );
    const editB = insertText(
      placeAtLegacyEnd(stateFromPage(engineB.getState(), bindingB)),
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

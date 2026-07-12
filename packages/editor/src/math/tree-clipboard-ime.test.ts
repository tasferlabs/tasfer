import { insertText } from "../actions/actions";
import {
  buildClipboardPayload,
  pasteFromClipboardEvent,
} from "../actions/clipboard";
import { CUT } from "../actions/input-actions";
import {
  handleCompositionEnd,
  handleCompositionStart,
} from "../events/compositionEvents";
import { mathExtension } from "../math-extension";
import { createMarkRegistry } from "../rendering/marks";
import { createNodeRegistry } from "../rendering/nodes";
import { baseSchema } from "../schema";
import { moveCursorToPosition } from "../selection";
import { loadPage } from "../serlization/loadPage";
import type { EditorState, ViewportState } from "../state-types";
import { createInitialState } from "../state-utils";
import {
  type ContentGapPoint,
  type ContentTextPoint,
  updateContentSelection,
} from "../structured-selection";
import { iterateAllChars } from "../sync/char-runs";
import { createCRDTbinding } from "../sync/sync";
import {
  getMathStructuredDocument,
  getStructuredMathSource,
  structuredToMathDocument,
} from "./structured";
import { mathSourceRangeFromContentSelection } from "./tree-selection";
import { describe, expect, it } from "vitest";

const schema = baseSchema.use(mathExtension());
const viewport = {
  width: 800,
  height: 600,
  scrollY: 0,
  documentHeight: 1_000,
} satisfies ViewportState;

function composition(data: string): CompositionEvent {
  return { data } as CompositionEvent;
}

function equation(source: string): EditorState {
  const binding = createCRDTbinding("tree-input-correctness", "peer-a");
  let state = createInitialState(loadPage("$$\n\n$$", schema.data), {
    schema: schema.data,
    nodes: createNodeRegistry(schema.nodes),
    marks: createMarkRegistry(schema.marks),
    crdtBinding: binding,
  });
  state = moveCursorToPosition(state, 0, 0);
  for (const char of source) state = insertText(state, char).state;
  return state;
}

function source(state: EditorState): string | undefined {
  return getStructuredMathSource(state.document.page.blocks[0]);
}

function selectText(
  state: EditorState,
  start: number,
  end: number,
): EditorState {
  const block = state.document.page.blocks[0];
  const document = getMathStructuredDocument(block);
  const active = state.document.contentSelection?.focus;
  if (!document || active?.kind !== "text") {
    throw new Error("expected an active structured text caret");
  }
  const node = document.nodes[active.nodeId];
  const characters = [
    ...iterateAllChars([...(node.textFields[active.field] ?? [])]),
  ].filter((entry) => !entry.deleted);
  const point = (offset: number): ContentTextPoint => ({
    ...active,
    afterCharId: characters[offset - 1]?.id ?? null,
  });
  return updateContentSelection(state, {
    anchor: point(start),
    focus: point(end),
    lastUpdate: Date.now(),
  });
}

function selectFirstRootChild(state: EditorState): EditorState {
  const block = state.document.page.blocks[0];
  const document = getMathStructuredDocument(block);
  const math = document ? structuredToMathDocument(document) : undefined;
  const child = math?.root.body.children[0];
  if (!document || !math || !child) {
    throw new Error("expected a structured root child");
  }
  const point = (afterNodeId: string | null): ContentGapPoint => ({
    kind: "gap",
    blockId: block.id,
    contentId: document.rootId,
    parentId: math.root.body.id,
    slot: "children",
    afterNodeId,
    affinity: "forward",
  });
  return updateContentSelection(state, {
    anchor: point(null),
    focus: point(child.id),
    lastUpdate: Date.now(),
  });
}

describe("structured math clipboard and IME correctness", () => {
  it("copies a nested text range through the math data facet", () => {
    const state = selectText(equation("abcd"), 1, 3);
    const document = getMathStructuredDocument(state.document.page.blocks[0]);

    expect(buildClipboardPayload(state)).toMatchObject({
      plainText: "bc",
      markdown: "bc",
    });
    expect(
      document && state.document.contentSelection
        ? mathSourceRangeFromContentSelection(
            document,
            state.document.contentSelection,
          )
        : null,
    ).toEqual({ from: 1, to: 3 });
  });

  it("cuts and pastes by replacing the nested range in one tree transaction", () => {
    const selected = selectText(equation("abcd"), 1, 3);
    const cut = selected.actionBus.dispatchState(CUT, selected);

    // No override claims CUT; its default transform still routes the nested
    // range through the feature input rule.
    expect(cut.claimed).toBe(false);
    expect(source(cut.state)).toBe("ad");
    expect(cut.ops.every((op) => op.op === "content_edit")).toBe(true);

    const pasted = pasteFromClipboardEvent(
      selectText(equation("abcd"), 1, 3),
      {} as ClipboardEvent,
      {
        // Structured paste deliberately chooses the plain flavor and never
        // tries to splice parsed flat blocks into an extension-owned tree.
        html: "<strong>wrong surface</strong>",
        text: "XY",
        imageFile: null,
      },
    );
    expect(pasted).not.toBeNull();
    expect(source(pasted!.state)).toBe("aXYd");
    expect(pasted!.ops.every((op) => op.op === "content_edit")).toBe(true);
  });

  it("copies and cuts a whole semantic fraction as canonical source", () => {
    const selected = selectFirstRootChild(equation(String.raw`\frac`));

    expect(buildClipboardPayload(selected)?.plainText).toBe(
      String.raw`\frac{}{}`,
    );
    const cut = selected.actionBus.dispatchState(CUT, selected);
    expect(source(cut.state)).toBe("");
    expect(cut.ops.some((op) => op.op === "content_edit")).toBe(true);
  });

  it("keeps a structured range intact until IME commit, then replaces it", () => {
    let state = selectText(equation("abcd"), 1, 3);
    state = { ...state, view: { ...state.view, isFocused: true } };

    const started = handleCompositionStart(state, composition("あ")).state;
    expect(started.ui.composition?.startPosition).toMatchObject({
      kind: "text",
    });
    expect(started.document.contentSelection).toEqual(
      state.document.contentSelection,
    );
    expect(source(started)).toBe("abcd");

    const committed = handleCompositionEnd(
      started,
      composition("あ"),
      viewport,
    );
    expect(committed.state.ui.composition).toBeNull();
    expect(source(committed.state)).toBe("aあd");
    expect(committed.ops.every((op) => op.op === "content_edit")).toBe(true);
  });
});

/**
 * The reported repro: a schema that authorizes one display equation and nothing
 * else must keep it. Backspace at the equation's leading edge used to demote the
 * block to a paragraph, and two Backspaces on an emptied equation used to leave
 * an empty paragraph behind — both past `blocks` and `content`.
 *
 * The math node's delete handlers are deliberately left unguarded: the point of
 * the check is that it holds for a feature that never asks. These press real
 * keys through the event drain, where it runs.
 */
import { mathExtension } from "./math-extension";
import {
  getMathStructuredDocument,
  getStructuredMathSource,
  mathContentIdForBlock,
} from "./structured";
import { mathContentSelectionFromSourceOffset } from "./tree-selection";
import { createChromeRegionRegistry } from "@tasfer/editor/events/chromeRegions";
import { handleEvents } from "@tasfer/editor/events/events";
import { createInteractionSession } from "@tasfer/editor/events/interaction-session";
import { createMarkRegistry } from "@tasfer/editor/rendering/marks";
import { createNodeRegistry } from "@tasfer/editor/rendering/nodes";
import { baseSchema } from "@tasfer/editor/schema";
import { loadPage } from "@tasfer/editor/serlization/loadPage";
import type { EditorState, ViewportState } from "@tasfer/editor/state-types";
import { createInitialState } from "@tasfer/editor/state-utils";
import { updateContentSelection } from "@tasfer/editor/structured-selection";
import { createCRDTbinding } from "@tasfer/editor/sync/sync";
import { describe, expect, it } from "vitest";

const full = baseSchema.use(mathExtension());
/** The consumer's schema: one display equation, nothing else authorable. */
const onlyMath = full.restrict({ blocks: ["math"], content: "math" });
/** Same allow-list, a shape that does admit the demote's paragraph. */
const mathOrProse = full.restrict({ content: "(math|paragraph)+" });

const viewport: ViewportState = {
  width: 800,
  height: 1000,
  scrollY: 0,
  documentHeight: 2000,
};

function stateFor(schema: typeof full, markdown: string): EditorState {
  const base = createInitialState(loadPage(markdown, schema.data), {
    schema: schema.data,
    nodes: createNodeRegistry(schema.nodes),
    marks: createMarkRegistry(schema.marks),
    crdtBinding: createCRDTbinding("page", "peer"),
  });
  return { ...base, view: { ...base.view, isFocused: true } };
}

/** Nested caret at `sourceOffset` inside the display equation at `blockIndex`. */
function treeCaretAt(
  state: EditorState,
  blockIndex: number,
  sourceOffset: number,
): EditorState {
  const block = state.document.page.blocks[blockIndex];
  const document = getMathStructuredDocument(block);
  if (!document) throw new Error("expected a structured math block");
  const selection = mathContentSelectionFromSourceOffset(
    block.id,
    mathContentIdForBlock(block.id),
    document,
    sourceOffset,
  );
  if (!selection) throw new Error("expected a tree caret");
  return updateContentSelection(state, selection);
}

function backspace(state: EditorState): { state: EditorState; ops: unknown[] } {
  const session = createInteractionSession(createChromeRegionRegistry());
  const result = handleEvents(
    state,
    viewport,
    {
      start: 0,
      end: state.view.visibleBlocks.length - 1,
      startY: 0,
      scrollY: 0,
    },
    [
      {
        type: "keydown",
        key: "Backspace",
        code: "Backspace",
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        isTrusted: true,
        preventDefault() {},
        stopPropagation() {},
      },
    ] as never,
    viewport.documentHeight,
    { left: 0, top: 0 },
    session,
  );
  return { state: result.state, ops: result.ops };
}

function types(state: EditorState): string[] {
  return state.document.page.blocks
    .filter((block) => !block.deleted)
    .map((block) => block.type as string);
}

describe("a schema of exactly one equation", () => {
  it("keeps the equation when Backspace would demote it", () => {
    const state = treeCaretAt(stateFor(onlyMath, "$$\nE=mc^2\n$$"), 0, 0);
    const after = backspace(state);

    expect(after.ops).toHaveLength(0);
    expect(types(after.state)).toEqual(["math"]);
    expect(getStructuredMathSource(after.state.document.page.blocks[0])).toBe(
      "E=m{c}^{2}",
    );
  });

  it("keeps it through the presses that used to empty then delete it", () => {
    let state = treeCaretAt(stateFor(onlyMath, "$$\nx\n$$"), 0, 1);
    // Emptying the equation is an edit inside the tree — the block stays.
    state = backspace(state).state;
    expect(getStructuredMathSource(state.document.page.blocks[0])).toBe("");

    // The press that used to arm the node selection, and the one that used to
    // delete the block and leave an empty paragraph.
    state = backspace(state).state;
    state = backspace(state).state;
    expect(types(state)).toEqual(["math"]);
  });

  it("still demotes under a shape that admits the paragraph", () => {
    const state = treeCaretAt(stateFor(mathOrProse, "$$\nE=mc^2\n$$"), 0, 0);
    const after = backspace(state);

    expect(types(after.state)).toEqual(["paragraph"]);
  });
});

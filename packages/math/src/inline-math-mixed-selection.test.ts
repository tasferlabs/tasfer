/**
 * A text selection that takes only PART of an inline formula.
 *
 * The flat text holds a formula as one character, so a selection that ran out
 * of a formula used to grab it whole. Now the selection keeps the stop inside
 * the formula, and delete, typing over, cut and copy act on that part only:
 * the rest of the formula stays.
 */

import { resolveStructuredInlineMathRuns } from "./inline-structured";
import { mathExtension } from "./math-extension";
import {
  mathContentSelectionFromSourceOffset,
  mathSourceRangeFromContentSelection,
} from "./tree-selection";
import {
  deleteSelectedText,
  deleteSelectionThroughOwner,
  insertText,
  toggleFormat,
} from "@tasfer/editor/actions/actions";
import { buildClipboardPayload } from "@tasfer/editor/actions/clipboard";
import { extendSelectionOutOfStructuredMark } from "@tasfer/editor/actions/structured-marks";
import { createMarkRegistry } from "@tasfer/editor/rendering/marks";
import { createNodeRegistry } from "@tasfer/editor/rendering/nodes";
import { baseSchema } from "@tasfer/editor/schema";
import { moveCursorToPosition } from "@tasfer/editor/selection";
import { selectionInsideParts } from "@tasfer/editor/selection-inside";
import { loadPage } from "@tasfer/editor/serlization/loadPage";
import { serializeToMarkdown } from "@tasfer/editor/serlization/serializer";
import type { EditorState, Position } from "@tasfer/editor/state-types";
import { createInitialState } from "@tasfer/editor/state-utils";
import { updateContentSelection } from "@tasfer/editor/structured-selection";
import { isTextualBlock } from "@tasfer/editor/sync/block-registry";
import {
  recordUndoOps,
  redoState,
  undoState,
} from "@tasfer/editor/sync/crdt-undo";
import { createCRDTbinding } from "@tasfer/editor/sync/sync";
import { describe, expect, it } from "vitest";

const schema = baseSchema.use(mathExtension());

function load(markdown: string): EditorState {
  const state = createInitialState(loadPage(markdown, schema.data), {
    schema: schema.data,
    nodes: createNodeRegistry(schema.nodes),
    marks: createMarkRegistry(schema.marks),
    crdtBinding: createCRDTbinding("page", "peer"),
  });
  return moveCursorToPosition(state, 0, 1);
}

function chip(state: EditorState, blockIndex = 0, nth = 0) {
  const block = state.document.page.blocks[blockIndex];
  if (!isTextualBlock(block)) throw new Error("expected a textual block");
  const run = resolveStructuredInlineMathRuns(block)[nth];
  if (!run?.contentId || !run.document) throw new Error("expected a chip");
  return { block, contentId: run.contentId, document: run.document };
}

/**
 * A selection fixed at source `fixed` inside the block's formula, with its
 * moving end first at `held` inside the formula and then out at `target`.
 */
function selectFrom(
  state: EditorState,
  fixed: number,
  held: number,
  target: Position,
) {
  const { block, contentId, document } = chip(state);
  const at = (offset: number) =>
    mathContentSelectionFromSourceOffset(block.id, contentId, document, offset)!
      .focus;
  const inside = updateContentSelection(state, {
    anchor: at(fixed),
    focus: at(held),
    lastUpdate: 0,
  });
  const out = extendSelectionOutOfStructuredMark(inside, target);
  if (!out) throw new Error("expected the selection to leave the formula");
  return out;
}

function markdown(state: EditorState) {
  return serializeToMarkdown(state.document.page.blocks, undefined, {
    schema: state.schema,
  }).trim();
}

/** The source range of each formula part the selection holds. */
function parts(state: EditorState) {
  return selectionInsideParts(state).map((part) =>
    mathSourceRangeFromContentSelection(chip(state).document, part.selection),
  );
}

// `a+b+c+d` is source 0..7 and sits at flat 3..4 of "hi ￼ yo".
const md = "hi $a+b+c+d$ yo";

describe("a selection running out of the end of a formula", () => {
  const select = () =>
    selectFrom(load(md), 2, 4, { blockIndex: 0, textIndex: 6 });

  it("holds the formula from the stop to its end, plus the text", () => {
    expect(parts(select())).toEqual([{ from: 2, to: 7 }]);
  });

  it("deletes that part and the text, and keeps the rest of the formula", () => {
    const result = deleteSelectedText(select());
    expect(markdown(result.state)).toBe("hi $a+$o");
    expect(result.state.document.selection).toBeNull();
    expect(result.state.document.cursor?.position).toEqual({
      blockIndex: 0,
      textIndex: 4,
    });
  });

  it("cuts the same way", () => {
    expect(markdown(deleteSelectionThroughOwner(select()).state)).toBe(
      "hi $a+$o",
    );
  });

  it("puts typed text after what is left of the formula", () => {
    expect(markdown(insertText(select(), "X").state)).toBe("hi $a+$Xo");
  });

  it("copies the part as a formula of its own, with the text", () => {
    const state = select();
    expect(buildClipboardPayload(state)?.plainText).toBe("$b+c+d$ y");
    expect(buildClipboardPayload(state)?.markdown).toBe("$b+c+d$ y");
    // Copying changes nothing.
    expect(markdown(state)).toBe(md);
  });
});

describe("formatting a selection that takes part of a formula", () => {
  const select = () =>
    selectFrom(load(md), 2, 4, { blockIndex: 0, textIndex: 6 });

  it("makes the text outside the formula bold and leaves the formula alone", () => {
    const state = select();
    const bold = toggleFormat(state, "strong");
    expect(markdown(bold.state)).toBe("hi $a+b+c+d$** y**o");
    // The selection the user made is still there.
    expect(parts(bold.state)).toEqual([{ from: 2, to: 7 }]);
  });

  it("does not turn it into one formula", () => {
    const state = select();
    const math = toggleFormat(state, "math");
    expect(math.ops).toEqual([]);
    expect(markdown(math.state)).toBe(md);
  });
});

describe("undoing a delete of part of a formula", () => {
  it("brings the formula back whole, with the same part selected", () => {
    const before = selectFrom(load(md), 2, 4, { blockIndex: 0, textIndex: 6 });
    const deleted = deleteSelectedText(before);
    const recorded = recordUndoOps(
      before,
      deleted.state,
      deleted.ops,
      before.CRDTbinding.getPeerId(),
    );

    const undone = undoState(recorded).state;
    expect(markdown(undone)).toBe(md);
    expect(parts(undone)).toEqual([{ from: 2, to: 7 }]);

    const redone = redoState(undone).state;
    expect(markdown(redone)).toBe("hi $a+$o");
  });
});

describe("a selection running out of the start of a formula", () => {
  const select = () =>
    selectFrom(load(md), 4, 2, { blockIndex: 0, textIndex: 1 });

  it("holds the formula from its start to the stop", () => {
    expect(parts(select())).toEqual([{ from: 0, to: 4 }]);
  });

  it("deletes that part and the text before it", () => {
    const result = deleteSelectedText(select());
    expect(markdown(result.state)).toBe("h$c+d$ yo");
    expect(result.state.document.cursor?.position).toEqual({
      blockIndex: 0,
      textIndex: 1,
    });
  });

  it("copies the text and the part", () => {
    expect(buildClipboardPayload(select())?.markdown).toBe("i $a+b+$");
  });
});

describe("a selection running from a formula into the next paragraph", () => {
  const twoBlocks = `${md}\n\nnext line`;
  const select = () => {
    const state = load(twoBlocks);
    const last = state.document.page.blocks.length - 1;
    return selectFrom(state, 2, 4, { blockIndex: last, textIndex: 4 });
  };

  it("deletes the part, the rest of the line and the start of the next", () => {
    expect(markdown(deleteSelectedText(select()).state)).toBe("hi $a+$ line");
  });

  it("copies the part and both lines' text", () => {
    expect(buildClipboardPayload(select())?.markdown).toBe(
      "$b+c+d$ yo\n\nnext",
    );
  });
});

describe("a stop inside a root", () => {
  // `\sqrt{x}` is source 2..10 of `a+\sqrt{x}+b`.
  const root = "hi $a+\\sqrt{x}+b$ yo";

  it("takes the root whole with the part", () => {
    const state = selectFrom(load(root), 8, 9, { blockIndex: 0, textIndex: 6 });
    expect(parts(state)).toEqual([{ from: 2, to: 12 }]);
    expect(markdown(deleteSelectedText(state).state)).toBe("hi $a+$o");
  });
});

describe("a selection that ends up holding the formula whole or not at all", () => {
  it("is a plain selection of the whole formula when the stop is at its far edge", () => {
    const state = selectFrom(load(md), 0, 4, { blockIndex: 0, textIndex: 6 });
    expect(parts(state)).toEqual([]);
    expect(markdown(deleteSelectedText(state).state)).toBe("hi o");
  });

  it("leaves the formula alone when the stop is at the edge the selection left by", () => {
    const state = selectFrom(load(md), 0, 4, { blockIndex: 0, textIndex: 1 });
    expect(parts(state)).toEqual([]);
    expect(markdown(deleteSelectedText(state).state)).toBe("h$a+b+c+d$ yo");
  });
});

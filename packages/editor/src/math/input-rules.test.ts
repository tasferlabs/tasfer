import {
  createMathTestState,
  loadMathPage,
  mathTestSchema,
} from "../__testutils__/math";
import { insertText } from "../actions/actions";
import { getBaseDataSchema } from "../baseDataSchema";
import { STRUCTURED_MARK_ANCHOR_CHAR } from "../feature-facets";
import { resolveMarkRuns } from "../inline-math-spans";
import { moveCursorToPosition } from "../selection";
import { loadPage } from "../serlization/loadPage";
import { serializeToMarkdown } from "../serlization/serializer";
import type { EditorState, Operation } from "../state-types";
import { createInitialState } from "../state-utils";
import { getVisibleTextFromRuns } from "../sync/char-runs";
import { recordUndoOps, redoState, undoState } from "../sync/crdt-undo";
import { mathDataExtension } from "./data";
import { resolveStructuredInlineMathRuns } from "./inline-structured";
import { mathInputRules } from "./input-rules";
import {
  getMathStructuredDocument,
  getStructuredMathSource,
} from "./structured";
import { describe, expect, it } from "vitest";

function source(state: EditorState): string {
  const block = state.document.page.blocks[0];
  return "charRuns" in block ? getVisibleTextFromRuns(block.charRuns) : "";
}

function chipLatex(state: EditorState): (string | undefined)[] {
  const block = state.document.page.blocks[0];
  return "charRuns" in block
    ? resolveStructuredInlineMathRuns(block).map((run) => run.latex)
    : [];
}

function type(
  state: EditorState,
  text: string,
): { state: EditorState; lastOps: Operation[]; beforeLast: EditorState } {
  if (!state.document.cursor) state = moveCursorToPosition(state, 0, 0);
  let lastOps: Operation[] = [];
  let beforeLast = state;
  for (const char of text) {
    beforeLast = state;
    const result = insertText(state, char);
    state = result.state;
    lastOps = result.ops;
  }
  return { state, lastOps, beforeLast };
}

describe("optional math live-input rules", () => {
  it("keeps dollar commands literal when math is not installed", () => {
    const inline = type(createInitialState(loadPage("")), "$x$").state;
    expect(source(inline)).toBe("$x$");
    expect(resolveMarkRuns(inline.document.page.blocks[0])).toEqual([]);

    const display = type(createInitialState(loadPage("")), "$$").state;
    expect(display.document.page.blocks[0].type).toBe("paragraph");
    expect(source(display)).toBe("$$");
  });

  it("keeps the canvas-free data extension free of live authoring rules", () => {
    const schema = getBaseDataSchema().extend(mathDataExtension());
    const state = createInitialState(loadPage("", schema), { schema });
    const inline = type(state, "$x$").state;

    expect(schema.hasBlock("math")).toBe(true);
    expect(schema.hasMark("math")).toBe(true);
    expect(schema.inputRules("after-insert")).toEqual([]);
    expect(source(inline)).toBe("$x$");
    expect(resolveMarkRuns(inline.document.page.blocks[0])).toEqual([]);
  });

  it("installs the shortcuts through the full interactive extension", () => {
    const state = createInitialState(loadPage("", mathTestSchema.data), {
      schema: mathTestSchema.data,
    });
    const inline = type(state, "$x$").state;

    // The typed source is replaced by the chip's single anchor char; the
    // formula lives in the mark's eager attachment.
    expect(source(inline)).toBe(STRUCTURED_MARK_ANCHOR_CHAR);
    expect(resolveMarkRuns(inline.document.page.blocks[0])[0]?.name).toBe(
      "math",
    );
    expect(chipLatex(inline)).toEqual(["x"]);
  });

  it("turns a typed $…$ pair into one attached mark in the same transaction", () => {
    const result = type(createMathTestState(loadMathPage("")), "$x$");

    expect(source(result.state)).toBe(STRUCTURED_MARK_ANCHOR_CHAR);
    const run = resolveMarkRuns(result.state.document.page.blocks[0])[0];
    expect(run).toMatchObject({
      name: "math",
      startIndex: 0,
      endIndex: 1,
      text: STRUCTURED_MARK_ANCHOR_CHAR,
    });
    // The attachment is minted in the SAME transaction as the anchor char, so
    // no keystroke ever observes a chip without its document.
    expect(typeof run.attrs.contentId).toBe("string");
    expect(chipLatex(result.state)).toEqual(["x"]);
    expect(result.lastOps.map((op) => op.op)).toEqual([
      "text_insert",
      "content_edit",
      "text_insert",
      "text_delete",
      "mark_set",
    ]);

    const recorded = recordUndoOps(
      result.beforeLast,
      result.state,
      result.lastOps,
      result.state.CRDTbinding.getPeerId(),
    );
    const undone = undoState(recorded).state;
    expect(source(undone)).toBe("$x");
    expect(resolveMarkRuns(undone.document.page.blocks[0])).toEqual([]);
  });

  it("normalizes an incomplete typed command when the pair closes", () => {
    // `$\frac$` — the closing `$` commits the source through the semantic
    // parse, which materializes the command's empty slots.
    const result = type(createMathTestState(loadMathPage("")), "$\\frac$");

    expect(source(result.state)).toBe(STRUCTURED_MARK_ANCHOR_CHAR);
    expect(chipLatex(result.state)).toEqual(["\\frac{}{}"]);
  });

  it("round-trips a typed chip through markdown from its attachment", () => {
    const created = type(createMathTestState(loadMathPage("")), "$x+y$").state;

    expect(chipLatex(created)).toEqual(["x+y"]);
    expect(
      serializeToMarkdown(created.document.page.blocks, undefined, {
        schema: created.schema,
      }),
    ).toBe("$x+y$");
  });

  it("turns a line containing only $$ into a math block with an eager tree", () => {
    const result = type(createMathTestState(loadMathPage("")), "$$");

    const block = result.state.document.page.blocks[0];
    expect(block.type).toBe("math");
    expect(source(result.state)).toBe("");
    // The block-authority document is minted eagerly: tree mode is the only
    // editing surface a display equation ever has.
    expect(getMathStructuredDocument(block)).toBeDefined();
    expect(getStructuredMathSource(block)).toBe("");
    expect(result.lastOps.map((op) => op.op)).toEqual([
      "text_insert",
      "text_delete",
      "block_set",
      "content_edit",
    ]);
  });

  it("undoes the $$ morph back to a paragraph and redoes it", () => {
    // The morph's transaction includes the eager `document_init`; its inverse
    // (`document_delete`) must clear the block authority so the inverse
    // `block_set(type)` is not refused by the authority guard.
    const typed = type(createMathTestState(loadMathPage("")), "$$");
    expect(typed.state.document.page.blocks[0].type).toBe("math");

    const recorded = recordUndoOps(
      typed.beforeLast,
      typed.state,
      typed.lastOps,
      typed.state.CRDTbinding.getPeerId(),
    );
    const undone = undoState(recorded).state;
    expect(undone.document.page.blocks[0].type).toBe("paragraph");
    expect(getMathStructuredDocument(undone.document.page.blocks[0])).toBe(
      undefined,
    );

    const redone = redoState(undone).state;
    expect(redone.document.page.blocks[0].type).toBe("math");
    expect(getMathStructuredDocument(redone.document.page.blocks[0]))
      .toBeDefined();
  });

  it("keeps full-extension input facets available to custom editor schemas", () => {
    const appDataSchema = mathTestSchema.data;
    expect(
      appDataSchema.inputRules("after-insert").map((rule) => rule.id),
    ).toEqual([
      "math.input.display-dollar-pair",
      "math.input.inline-dollar-pair",
    ]);

    const state = createMathTestState(loadPage(""), {
      schema: appDataSchema,
    });
    const result = type(state, "$$").state;
    expect(result.document.page.blocks[0].type).toBe("math");
  });

  it("offers explicit schemas the combined structured math bundle", () => {
    const schema = getBaseDataSchema()
      .extend(mathDataExtension())
      .withFeatures({ inputRules: mathInputRules });
    const ids = schema.inputRules("before-insert").map((rule) => rule.id);

    expect(ids).toContain("math.inline-tree.input");
    expect(ids).toContain("math.tree.input");
    expect(mathInputRules[0].id).toBe("math.inline-tree.input");
  });
});

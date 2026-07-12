import {
  createMathTestState,
  loadMathPage,
  mathTestSchema,
} from "../__testutils__/math";
import { insertText } from "../actions/actions";
import { getBaseDataSchema } from "../baseDataSchema";
import { resolveMarkRuns } from "../inline-math-spans";
import { moveCursorToPosition } from "../selection";
import { loadPage } from "../serlization/loadPage";
import { serializeToMarkdown } from "../serlization/serializer";
import type { EditorState, Operation } from "../state-types";
import { createInitialState } from "../state-utils";
import { getVisibleTextFromRuns } from "../sync/char-runs";
import { recordUndoOps, redoState, undoState } from "../sync/crdt-undo";
import { mathDataExtension } from "./data";
import { mathInlineTreeInputRules, mathTreeInputRules } from "./input-rules";
import { describe, expect, it } from "vitest";

function source(state: EditorState): string {
  const block = state.document.page.blocks[0];
  return "charRuns" in block ? getVisibleTextFromRuns(block.charRuns) : "";
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
    expect(schema.features.inputRules("after-insert")).toEqual([]);
    expect(source(inline)).toBe("$x$");
    expect(resolveMarkRuns(inline.document.page.blocks[0])).toEqual([]);
  });

  it("installs the shortcuts through the full interactive extension", () => {
    const state = createInitialState(loadPage("", mathTestSchema.data), {
      schema: mathTestSchema.data,
    });
    const inline = type(state, "$x$").state;

    expect(source(inline)).toBe("x");
    expect(resolveMarkRuns(inline.document.page.blocks[0])[0]?.name).toBe(
      "math",
    );
  });

  it("turns a typed $…$ pair into one math mark in the same transaction", () => {
    const result = type(createMathTestState(loadMathPage("")), "$x$");

    expect(source(result.state)).toBe("x");
    expect(resolveMarkRuns(result.state.document.page.blocks[0])).toEqual([
      {
        name: "math",
        attrs: {},
        startIndex: 0,
        endIndex: 1,
        text: "x",
      },
    ]);
    expect(result.lastOps.map((op) => op.op)).toEqual([
      "text_insert",
      "text_delete",
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

  it("keeps the default inline editor on its complete legacy path", () => {
    const created = type(createMathTestState(loadMathPage("")), "$x$").state;
    const edited = insertText(created, "2").state;
    const run = resolveMarkRuns(edited.document.page.blocks[0])[0];

    const block = edited.document.page.blocks[0];
    expect(run.text).toBe("x2");
    expect(
      serializeToMarkdown(edited.document.page.blocks, undefined, {
        schema: edited.schema,
      }),
    ).toBe("$x2$");
    expect(block.structuredContent).toBeUndefined();
  });

  it("normalizes from the transformed inline caret in the same edit", () => {
    const result = type(
      createMathTestState(loadMathPage("")),
      "$\\frac$",
    ).state;

    expect(source(result)).toBe("\\frac{}{}");
    expect(result.document.cursor?.position.textIndex).toBe(6);
    expect(resolveMarkRuns(result.document.page.blocks[0])[0]?.text).toBe(
      "\\frac{}{}",
    );
  });

  it("turns a line containing only $$ into a math block and round-trips undo", () => {
    const result = type(createMathTestState(loadMathPage("")), "$$");

    expect(result.state.document.page.blocks[0].type).toBe("math");
    expect(source(result.state)).toBe("");
    expect(result.lastOps.map((op) => op.op)).toEqual([
      "text_insert",
      "text_delete",
      "block_set",
    ]);

    const recorded = recordUndoOps(
      result.beforeLast,
      result.state,
      result.lastOps,
      result.state.CRDTbinding.getPeerId(),
    );
    const undone = undoState(recorded).state;
    expect(undone.document.page.blocks[0].type).toBe("paragraph");
    expect(source(undone)).toBe("$");

    const redone = redoState(undone).state;
    expect(redone.document.page.blocks[0].type).toBe("math");
    expect(source(redone)).toBe("");
  });

  it("keeps full-extension input facets available to custom editor schemas", () => {
    const appDataSchema = mathTestSchema.data;
    expect(mathTreeInputRules.map((rule) => rule.id)).toContain(
      "math.inline-tree.attached-projection-guard",
    );
    expect(
      appDataSchema.features.inputRules("after-insert").map((rule) => rule.id),
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

  it("offers explicit schemas one combined display-and-inline tree bundle", () => {
    const schema = getBaseDataSchema()
      .extend(mathDataExtension())
      .withFeatures({ inputRules: mathInlineTreeInputRules });
    const ids = schema.features
      .inputRules("before-insert")
      .map((rule) => rule.id);

    expect(ids).toContain("math.inline-tree.input");
    expect(ids).toContain("math.tree.migrate");
    expect(ids).toContain("math.inline-tree.attached-projection-guard");
    expect(mathInlineTreeInputRules[0].id).toBe("math.inline-tree.input");
  });
});

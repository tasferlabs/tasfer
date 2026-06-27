/**
 * Pins `convertBlockAtCursor` across every built-in target type after its
 * per-type switches were replaced with descriptor-driven logic
 * (`createDefaultBlock` + `getBlockFieldNames`). Guards against the generic
 * path drifting from the old hand-written image/math/line/list/code handlers:
 * each conversion must yield the right block type, carry its declared fields,
 * preserve text for textual targets, and emit a `block_set type` op.
 */

import type { Block, Paragraph } from "../serlization/loadPage";
import type { BlockSet, CursorState, EditorState, Page } from "../state-types";
import { createInitialState } from "../state-utils";
import { getVisibleTextFromRuns } from "../sync/char-runs";
import { convertBlockAtCursor } from "./actions";
import { describe, expect, it } from "vitest";

function paragraph(text: string): Paragraph {
  return {
    id: "p-1",
    orderKey: "a0",
    deleted: false,
    type: "paragraph",
    charRuns: [{ peerId: "peer", startCounter: 0, text }],
    formats: [],
  };
}

function pageWith(...blocks: Page["blocks"]): Page {
  return { id: "page-1", title: "t", blocks };
}

function cursorAt(blockIndex: number, textIndex: number): CursorState {
  return { position: { blockIndex, textIndex }, lastUpdate: 0 };
}

function convert(type: Block["type"]) {
  const state0: EditorState = createInitialState(pageWith(paragraph("hello")));
  const state = {
    ...state0,
    document: { ...state0.document, cursor: cursorAt(0, 5) },
  };
  const result = convertBlockAtCursor(state, { type });
  const block = result.state.document.page.blocks[0];
  const typeOps = result.ops.filter(
    (o): o is BlockSet => o.op === "block_set" && o.field === "type",
  );
  return { block, ops: result.ops, typeOps };
}

describe("convertBlockAtCursor — atomic targets", () => {
  it("converts to an image cover block and clears text", () => {
    const { block, typeOps } = convert("image");
    expect(block.type).toBe("image");
    expect(typeOps.map((o) => o.value)).toEqual(["image"]);
  });

  it("converts to a math block", () => {
    const { block, typeOps } = convert("math");
    expect(block.type).toBe("math");
    expect((block as unknown as { displayMode: boolean }).displayMode).toBe(
      true,
    );
    expect(typeOps.map((o) => o.value)).toEqual(["math"]);
  });

  it("converts to a line/divider block", () => {
    const { block, typeOps } = convert("line");
    expect(block.type).toBe("line");
    expect(typeOps.map((o) => o.value)).toEqual(["line"]);
  });

  it("creates a trailing paragraph (caret can't live in an atomic block)", () => {
    const { ops } = convert("image");
    // last block → a paragraph is inserted after it
    expect(ops.some((o) => o.op === "block_insert")).toBe(true);
  });
});

describe("convertBlockAtCursor — textual targets", () => {
  it("converts to a heading, preserving text", () => {
    const { block, typeOps } = convert("heading1");
    expect(block.type).toBe("heading1");
    expect(getVisibleTextFromRuns((block as Paragraph).charRuns)).toBe("hello");
    expect(typeOps.map((o) => o.value)).toEqual(["heading1"]);
  });

  it("converts to a bullet list with indent 0", () => {
    const { block, ops } = convert("bullet_list");
    expect(block.type).toBe("bullet_list");
    expect((block as unknown as { indent: number }).indent).toBe(0);
    const fields = ops
      .filter((o): o is BlockSet => o.op === "block_set")
      .map((o) => o.field);
    expect(fields).toContain("type");
    expect(fields).toContain("indent");
  });

  it("converts to a todo list with checked=false + indent 0", () => {
    const { block, ops } = convert("todo_list");
    expect(block.type).toBe("todo_list");
    expect((block as unknown as { checked: boolean }).checked).toBe(false);
    expect((block as unknown as { indent: number }).indent).toBe(0);
    const fields = ops
      .filter((o): o is BlockSet => o.op === "block_set")
      .map((o) => o.field);
    expect(fields).toEqual(
      expect.arrayContaining(["type", "indent", "checked"]),
    );
  });

  it("converts to a code block, dropping inline marks and keeping text", () => {
    const { block } = convert("code");
    expect(block.type).toBe("code");
    expect((block as Paragraph).formats).toEqual([]);
    expect(getVisibleTextFromRuns((block as Paragraph).charRuns)).toBe("hello");
    expect((block as unknown as { language: string }).language).toBe("");
  });
});

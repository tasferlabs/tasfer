/**
 * Caret placement around structural conversions.
 *
 *  1. When markdown-prefix detection strips a prefix off the block start
 *     ("# hello" → heading "hello"), a caret placed afterwards must shift left
 *     by the removed length so it stays with the text it was next to — typing
 *     "# " before "hello" lands at "|hello", not "he|llo". Pinned across every
 *     path that can trigger the conversion: typing, backspace, forward-delete,
 *     and a cross-block merge whose joined text forms a prefix.
 *
 *  2. Forward-delete at the end of a NON-empty text block whose next block is
 *     atomic (image) selects the image without deleting the text block —
 *     mirroring what Backspace does on the other side of an image. Only an
 *     empty block is removed.
 */

import { baseSchema } from "../schema";
import type { Block, Page } from "../serlization/loadPage";
import type { CursorState, EditorState } from "../state-types";
import { createInitialState } from "../state-utils";
import { getVisibleTextFromRuns } from "../sync/char-runs";
import { deleteForward, deleteText, insertText } from "./actions";
import { describe, expect, it } from "vitest";

function textual(
  type: Block["type"],
  id: string,
  orderKey: string,
  text: string,
): Block {
  return {
    id,
    orderKey,
    deleted: false,
    type,
    charRuns: text ? [{ peerId: "peer", startCounter: 0, text }] : [],
    formats: [],
  } as unknown as Block;
}

function image(id: string, orderKey: string): Block {
  return {
    id,
    orderKey,
    deleted: false,
    type: "image",
    url: "https://example.com/a.png",
  } as unknown as Block;
}

function pageWith(...blocks: Block[]): Page {
  return { id: "page-1", title: "t", blocks };
}

function cursorAt(blockIndex: number, textIndex: number): CursorState {
  return { position: { blockIndex, textIndex }, lastUpdate: 0 };
}

function stateWith(page: Page, cursor: CursorState): EditorState {
  const base = createInitialState(page, { schema: baseSchema.data });
  return { ...base, document: { ...base.document, cursor } };
}

function text(block: Block): string {
  return getVisibleTextFromRuns((block as { charRuns?: [] }).charRuns);
}

describe("markdown prefix strip keeps the caret with its text", () => {
  it("typing '# ' before existing content lands the caret at the content start", () => {
    // "#|hello" + " " → "# hello" → heading strips the prefix → "|hello".
    const state = stateWith(
      pageWith(textual("paragraph", "p-1", "a0", "#hello")),
      cursorAt(0, 1),
    );
    const r = insertText(state, " ");
    const block = r.state.document.page.blocks[0];
    expect(block.type).toBe("heading1");
    expect(text(block)).toBe("hello");
    expect(r.state.document.cursor?.position).toEqual({
      blockIndex: 0,
      textIndex: 0,
    });
  });

  it("a backspace that forms a prefix lands the caret at the content start", () => {
    // "#x| hello" + Backspace → "# hello" → heading "hello", caret at 0.
    const state = stateWith(
      pageWith(textual("paragraph", "p-1", "a0", "#x hello")),
      cursorAt(0, 2),
    );
    const r = deleteText(state);
    const block = r.state.document.page.blocks[0];
    expect(block.type).toBe("heading1");
    expect(text(block)).toBe("hello");
    expect(r.state.document.cursor?.position).toEqual({
      blockIndex: 0,
      textIndex: 0,
    });
  });

  it("a forward-delete that forms a prefix lands the caret at the content start", () => {
    // "#|x hello" + Delete → "# hello" → heading "hello", caret at 0.
    const state = stateWith(
      pageWith(textual("paragraph", "p-1", "a0", "#x hello")),
      cursorAt(0, 1),
    );
    const r = deleteForward(state);
    const block = r.state.document.page.blocks[0];
    expect(block.type).toBe("heading1");
    expect(text(block)).toBe("hello");
    expect(r.state.document.cursor?.position).toEqual({
      blockIndex: 0,
      textIndex: 0,
    });
  });

  it("a merge whose joined text forms a prefix lands the caret at the content start", () => {
    // ["1. ", "|item"] + Backspace at the start of "item" → "1. item" →
    // numbered list "item"; the caret sits at the seam, now offset 0.
    const state = stateWith(
      pageWith(
        textual("paragraph", "p-1", "a0", "1. "),
        textual("paragraph", "p-2", "a1", "item"),
      ),
      cursorAt(1, 0),
    );
    const r = deleteText(state);
    const block = r.state.document.page.blocks[0];
    expect(block.type).toBe("numbered_list");
    expect(text(block)).toBe("item");
    expect(r.state.document.cursor?.position).toEqual({
      blockIndex: 0,
      textIndex: 0,
    });
  });
});

describe("forward-delete before an atomic block", () => {
  it("keeps a non-empty text block and only selects the image", () => {
    const state = stateWith(
      pageWith(textual("paragraph", "p-1", "a0", "hello"), image("i-1", "a1")),
      cursorAt(0, 5),
    );
    const r = deleteForward(state);
    expect(r.ops.some((op) => op.op === "block_delete")).toBe(false);
    const paragraph = r.state.document.page.blocks[0];
    expect(paragraph.deleted).toBeFalsy();
    expect(text(paragraph)).toBe("hello");
    const imagePosition = { blockIndex: 1, textIndex: 0 };
    expect(r.state.document.selection).toMatchObject({
      anchor: imagePosition,
      focus: imagePosition,
      isCollapsed: false,
    });
  });

  it("still removes an EMPTY text block and selects the image", () => {
    const state = stateWith(
      pageWith(textual("paragraph", "p-1", "a0", ""), image("i-1", "a1")),
      cursorAt(0, 0),
    );
    const r = deleteForward(state);
    expect(
      r.ops.some((op) => op.op === "block_delete" && op.blockId === "p-1"),
    ).toBe(true);
    expect(r.state.document.page.blocks[0].deleted).toBe(true);
    const imagePosition = { blockIndex: 1, textIndex: 0 };
    expect(r.state.document.selection).toMatchObject({
      anchor: imagePosition,
      focus: imagePosition,
      isCollapsed: false,
    });
  });
});

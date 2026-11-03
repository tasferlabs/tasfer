/**
 * Pasting inside a code block inserts the clipboard text verbatim. The block is
 * source, not Markdown: before, a pasted file was parsed into blocks and broke
 * out of the code block as headings, lists and paragraphs. See
 * `pasteIntoPreformattedBlock`.
 */

import { moveCursorToPosition } from "../selection";
import type { Block, CharRun } from "../serlization/loadPage";
import { loadPage } from "../serlization/loadPage";
import type { EditorState } from "../state-types";
import { createInitialState } from "../state-utils";
import { getVisibleTextFromRuns } from "../sync/char-runs";
import { applyOps, getVisibleBlocks } from "../sync/reducer";
import { insertClipboardPayload, pasteFromClipboardEvent } from "./clipboard";
import { describe, expect, it } from "vitest";

const SOURCE = [
  "# not a heading",
  "- not a list",
  "",
  "def f(x):",
  "    return x * 2  # **not bold**",
  "$x$",
].join("\n");

function paste(state: EditorState, text: string, html = "") {
  return pasteFromClipboardEvent(state, {} as ClipboardEvent, {
    html,
    text,
    imageFile: null,
  });
}

function blockText(b: Block): string {
  return getVisibleTextFromRuns((b as { charRuns: CharRun[] }).charRuns);
}

function codeDoc(code: string, textIndex: number): EditorState {
  const state = createInitialState(loadPage("```python\n" + code + "\n```"));
  return moveCursorToPosition(state, 0, textIndex);
}

describe("paste into a code block", () => {
  it("inserts the text verbatim into an empty code block", () => {
    const state = codeDoc("", 0);
    const result = paste(state, SOURCE);
    expect(result).not.toBeNull();

    const blocks = getVisibleBlocks(result!.state.document.page);
    expect(blocks.map((b) => b.type)).toEqual(["code"]);
    expect(blockText(blocks[0])).toBe(SOURCE);
    expect((blocks[0] as { formats?: unknown[] }).formats ?? []).toEqual([]);

    const replayed = getVisibleBlocks(
      applyOps(state.document.page, result!.ops),
    );
    expect(replayed.map(blockText)).toEqual([SOURCE]);
  });

  it("inserts at the caret, between existing lines", () => {
    const result = paste(codeDoc("a\nb", 2), "x\ny\n");
    const blocks = getVisibleBlocks(result!.state.document.page);
    expect(blocks.map((b) => b.type)).toEqual(["code"]);
    expect(blockText(blocks[0])).toBe("a\nx\ny\nb");
    expect(result!.state.document.cursor?.position.textIndex).toBe(6);
  });

  it("ignores the HTML flavor an editor puts on the clipboard", () => {
    const html = "<pre><span>const</span> a = <b>1</b>;</pre><h1>x</h1>";
    const result = paste(codeDoc("", 0), "const a = 1;\n# x", html);
    const blocks = getVisibleBlocks(result!.state.document.page);
    expect(blocks.map((b) => b.type)).toEqual(["code"]);
    expect(blockText(blocks[0])).toBe("const a = 1;\n# x");
  });

  it("turns CRLF line breaks into the block's newline", () => {
    const result = paste(codeDoc("", 0), "a\r\nb\rc");
    expect(blockText(getVisibleBlocks(result!.state.document.page)[0])).toBe(
      "a\nb\nc",
    );
  });

  it("replaces a selection inside the block", () => {
    const state = codeDoc("keep DROP keep", 0);
    const start = { blockIndex: 0, textIndex: 5 };
    const end = { blockIndex: 0, textIndex: 9 };
    const selected: EditorState = {
      ...state,
      document: {
        ...state.document,
        cursor: { position: end, lastUpdate: 0 },
        selection: {
          anchor: start,
          focus: end,
          isForward: true,
          isCollapsed: false,
          lastUpdate: 0,
          initialBoundary: { start, end },
        },
      },
    };
    const result = paste(selected, "- [ ] new");
    const blocks = getVisibleBlocks(result!.state.document.page);
    expect(blocks.map((b) => b.type)).toEqual(["code"]);
    expect(blockText(blocks[0])).toBe("keep - [ ] new keep");
  });

  it("drops dragged text into the block verbatim", () => {
    const result = insertClipboardPayload(codeDoc("", 0), {
      plainText: "## h\n- li",
      markdown: "## h\n- li",
      html: "<h2>h</h2><ul><li>li</li></ul>",
    });
    const blocks = getVisibleBlocks(result!.state.document.page);
    expect(blocks.map((b) => b.type)).toEqual(["code"]);
    expect(blockText(blocks[0])).toBe("## h\n- li");
  });

  it("still parses Markdown when the caret is in a paragraph", () => {
    const state = moveCursorToPosition(
      createInitialState(loadPage("\n")),
      0,
      0,
    );
    const result = paste(state, "# title\n- item");
    const blocks = getVisibleBlocks(result!.state.document.page);
    expect(blocks.map((b) => b.type)).toEqual(["heading1", "bullet_list"]);
  });
});

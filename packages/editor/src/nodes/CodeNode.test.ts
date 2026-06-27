import { insertText } from "../actions/actions";
import {
  DELETE_BACKWARD,
  SELECT_ALL,
  SPLIT_BLOCK,
} from "../actions/edit-actions";
import { loadPage } from "../serlization/loadPage";
import { serializeToMarkdown } from "../serlization/serializer";
import type { CursorState, EditorState, Page } from "../state-types";
import { createInitialState } from "../state-utils";
import { resolveTheme } from "../styles";
import { getVisibleTextFromRuns } from "../sync/char-runs";
import { type CodeBlock, CodeNode, INSERT_TAB } from "./CodeNode";
import type { TextualBlock } from "./TextNode";
import { describe, expect, it } from "vitest";

/** A code block whose single run carries `text` verbatim (newlines included). */
function codeBlock(text: string, language = ""): CodeBlock {
  return {
    id: "code-1",
    orderKey: "a0",
    deleted: false,
    type: "code",
    charRuns: [{ peerId: "peer", startCounter: 0, text }],
    formats: [],
    language,
  };
}

function pageWith(...blocks: Page["blocks"]): Page {
  return { id: "page-1", title: "t", blocks };
}

function cursorAt(blockIndex: number, textIndex: number): CursorState {
  return { position: { blockIndex, textIndex }, lastUpdate: 0 };
}

/** Place the caret in an existing state (state-only; no mount needed). */
function withCursor(state: EditorState, cursor: CursorState): EditorState {
  return { ...state, document: { ...state.document, cursor } };
}

describe("CodeNode layout", () => {
  const styles = resolveTheme({});
  const node = new CodeNode();
  // Wide enough that none of these short lines soft-wrap, so the only breaks are
  // the hard "\n" ones — which is exactly the index accounting under test.
  const layoutOf = (block: TextualBlock) =>
    node.computeLayout(block, 1000, styles);

  it("splits on hard newlines into separate lines with exact visible indices", () => {
    // visible: a(0) b(1) \n(2) \n(3) c(4) d(5)
    const layout = layoutOf(codeBlock("ab\n\ncd"));

    expect(layout.lines.map((l) => l.text)).toEqual(["ab", "", "cd"]);
    expect(layout.lines.map((l) => [l.startIndex, l.endIndex])).toEqual([
      [0, 2], // "ab", then the "\n" at index 2 is consumed
      [3, 3], // empty line, then the "\n" at index 3 is consumed
      [4, 6], // "cd"
    ]);
  });

  it("keeps a trailing newline as a final empty line", () => {
    const layout = layoutOf(codeBlock("x\n"));
    expect(layout.lines.map((l) => l.text)).toEqual(["x", ""]);
    expect(layout.lines.map((l) => [l.startIndex, l.endIndex])).toEqual([
      [0, 1],
      [2, 2],
    ]);
  });

  it("lays a single empty block out as one empty line", () => {
    const layout = layoutOf(codeBlock(""));
    expect(layout.lines.map((l) => l.text)).toEqual([""]);
  });

  it("maps the caret onto the correct visual line (later lines sit lower)", () => {
    const block = codeBlock("ab\n\ncd");
    const layout = layoutOf(block);

    const firstLine = node.caretRect(layout, 0, 0, 0); // start of "ab"
    const thirdLine = node.caretRect(layout, 4, 0, 0); // start of "cd"

    expect(thirdLine.y).toBeGreaterThan(firstLine.y);
    // Two line-heights apart (line 0 → line 2), and offset down by the top inset.
    expect(thirdLine.y - firstLine.y).toBeCloseTo(2 * layout.lineHeight);
    expect(firstLine.y).toBeCloseTo(layout.insetY);
  });
});

describe("CodeNode editing actions", () => {
  it("Enter inserts a newline inside a code block instead of splitting it", () => {
    const state0 = createInitialState(pageWith(codeBlock("ab")));
    const state = withCursor(state0, cursorAt(0, 2)); // caret at end of "ab"

    const result = state.actionBus.dispatchState(SPLIT_BLOCK, state);

    // Still one block (no split); its text now contains the newline.
    expect(result.state.document.page.blocks).toHaveLength(1);
    const block = result.state.document.page.blocks[0] as CodeBlock;
    expect(block.type).toBe("code");
    expect(getVisibleTextFromRuns(block.charRuns)).toBe("ab\n");
  });

  it("Backspace at the start of an empty code block exits to a paragraph", () => {
    const lead = {
      id: "p-0",
      orderKey: "a0",
      deleted: false as const,
      type: "paragraph" as const,
      charRuns: [{ peerId: "peer", startCounter: 0, text: "Lead" }],
      formats: [],
    };
    const empty = { ...codeBlock(""), id: "code-2", orderKey: "a1" as const };
    const state0 = createInitialState(pageWith(lead, empty));
    const state = withCursor(state0, cursorAt(1, 0));

    const result = state.actionBus.dispatchState(DELETE_BACKWARD, state);
    const live = result.state.document.page.blocks.filter((b) => !b.deleted);

    // Demoted in place; the previous paragraph is left untouched (no merge).
    expect(live.map((b) => b.type)).toEqual(["paragraph", "paragraph"]);
    expect(getVisibleTextFromRuns((live[0] as TextualBlock).charRuns)).toBe(
      "Lead",
    );
  });

  it("Backspace leaves a non-empty code block to default handling", () => {
    const state0 = createInitialState(pageWith(codeBlock("hi")));
    const state = withCursor(state0, cursorAt(0, 0));

    const result = state.actionBus.dispatchState(DELETE_BACKWARD, state);
    const block = result.state.document.page.blocks[0];

    expect(block.type).toBe("code");
  });

  it("Backspace from following text selects a previous code block before deleting it", () => {
    const code = codeBlock("const x = 1;");
    const paragraph = {
      id: "p-1",
      orderKey: "a1",
      deleted: false as const,
      type: "paragraph" as const,
      charRuns: [{ peerId: "peer", startCounter: 50, text: "after" }],
      formats: [],
    };
    const state0 = createInitialState(pageWith(code, paragraph));
    const state = withCursor(state0, cursorAt(1, 0));

    const selected = state.actionBus.dispatchState(DELETE_BACKWARD, state);

    expect(selected.ops).toHaveLength(0);
    expect(selected.state.document.page.blocks[0].type).toBe("code");
    expect(selected.state.document.page.blocks[0].deleted).toBe(false);
    expect(selected.state.document.selection).toMatchObject({
      anchor: { blockIndex: 0, textIndex: 0 },
      focus: { blockIndex: 0, textIndex: 0 },
      isCollapsed: false,
    });

    const deleted = selected.state.actionBus.dispatchState(
      DELETE_BACKWARD,
      selected.state,
    );

    expect(deleted.ops[0].op).toBe("block_delete");
    expect(deleted.state.document.page.blocks[0].deleted).toBe(true);
    expect(
      deleted.state.document.page.blocks.filter((block) => !block.deleted),
    ).toHaveLength(1);
  });

  it("Backspace from an empty following text block removes it and selects previous empty code", () => {
    const code = codeBlock("");
    const paragraph = {
      id: "p-1",
      orderKey: "a1",
      deleted: false as const,
      type: "paragraph" as const,
      charRuns: [],
      formats: [],
    };
    const state0 = createInitialState(pageWith(code, paragraph));
    const state = withCursor(state0, cursorAt(1, 0));

    const selected = state.actionBus.dispatchState(DELETE_BACKWARD, state);

    expect(selected.ops.map((op) => op.op)).toEqual(["block_delete"]);
    expect(selected.state.document.page.blocks[1].deleted).toBe(true);
    expect(selected.state.document.selection).toMatchObject({
      anchor: { blockIndex: 0, textIndex: 0 },
      focus: { blockIndex: 0, textIndex: 0 },
      isCollapsed: false,
    });

    const deleted = selected.state.actionBus.dispatchState(
      DELETE_BACKWARD,
      selected.state,
    );
    const live = deleted.state.document.page.blocks.filter(
      (block) => !block.deleted,
    );

    expect(deleted.ops.map((op) => op.op)).toEqual([
      "block_delete",
      "block_insert",
    ]);
    expect(live.map((block) => block.type)).toEqual(["paragraph"]);
  });

  it("Enter still splits a normal paragraph (regression)", () => {
    const paragraph = {
      id: "p-1",
      orderKey: "a0",
      deleted: false as const,
      type: "paragraph" as const,
      charRuns: [{ peerId: "peer", startCounter: 0, text: "ab" }],
      formats: [],
    };
    const state0 = createInitialState(pageWith(paragraph));
    const state = withCursor(state0, cursorAt(0, 2));

    const result = state.actionBus.dispatchState(SPLIT_BLOCK, state);

    expect(
      result.state.document.page.blocks.filter((b) => !b.deleted).length,
    ).toBe(2);
  });

  it("Tab inserts two spaces", () => {
    const state0 = createInitialState(pageWith(codeBlock("x")));
    const state = withCursor(state0, cursorAt(0, 1));

    const result = state.actionBus.dispatchState(INSERT_TAB, state);

    const block = result.state.document.page.blocks[0] as CodeBlock;
    expect(getVisibleTextFromRuns(block.charRuns)).toBe("x  ");
  });

  it("selects only the active code block on the first Ctrl/Cmd+A", () => {
    const code = "const x = 1;\nreturn x;";
    const paragraph = {
      id: "p-1",
      orderKey: "a1",
      deleted: false as const,
      type: "paragraph" as const,
      charRuns: [{ peerId: "peer", startCounter: 50, text: "after" }],
      formats: [],
    };
    const state0 = createInitialState(pageWith(codeBlock(code), paragraph));
    const state = withCursor(state0, cursorAt(0, 8));

    const result = state.actionBus.dispatchState(SELECT_ALL, state);

    expect(result.claimed).toBe(true);
    expect(result.state.document.selection?.anchor).toEqual({
      blockIndex: 0,
      textIndex: 0,
    });
    expect(result.state.document.selection?.focus).toEqual({
      blockIndex: 0,
      textIndex: code.length,
    });
  });

  it("selects the whole document on the second Ctrl/Cmd+A", () => {
    const code = "let x = 1;";
    const paragraph = {
      id: "p-1",
      orderKey: "a1",
      deleted: false as const,
      type: "paragraph" as const,
      charRuns: [{ peerId: "peer", startCounter: 50, text: "after" }],
      formats: [],
    };
    const state0 = createInitialState(pageWith(codeBlock(code), paragraph));
    const state = withCursor(state0, cursorAt(0, 4));

    const first = state.actionBus.dispatchState(SELECT_ALL, state);
    const second = first.state.actionBus.dispatchState(SELECT_ALL, first.state);

    expect(second.claimed).toBe(false);
    expect(second.state.document.selection?.anchor).toEqual({
      blockIndex: 0,
      textIndex: 0,
    });
    expect(second.state.document.selection?.focus).toEqual({
      blockIndex: 1,
      textIndex: 5,
    });
  });
});

describe("CodeNode backtick shortcut", () => {
  /** A paragraph whose single run carries `text` verbatim. */
  function paragraph(text: string) {
    return {
      id: "p-1",
      orderKey: "a0",
      deleted: false as const,
      type: "paragraph" as const,
      charRuns: [{ peerId: "peer", startCounter: 0, text }],
      formats: [],
    };
  }

  it("converts a paragraph to an empty code block on the third backtick", () => {
    // Caret after "``"; typing the closing backtick makes the block text "```".
    const state0 = createInitialState(pageWith(paragraph("``")));
    const state = withCursor(state0, cursorAt(0, 2));

    const result = insertText(state, "`");

    const blocks = result.state.document.page.blocks.filter((b) => !b.deleted);
    expect(blocks).toHaveLength(1);
    const block = blocks[0] as CodeBlock;
    expect(block.type).toBe("code");
    expect(block.language).toBe("");
    // The three backticks are consumed — the new code block starts empty.
    expect(getVisibleTextFromRuns(block.charRuns)).toBe("");
    // Caret clamps into the emptied block.
    expect(result.state.document.cursor?.position).toEqual({
      blockIndex: 0,
      textIndex: 0,
    });
  });

  it("does not convert backticks typed mid-paragraph", () => {
    const state0 = createInitialState(pageWith(paragraph("hi``")));
    const state = withCursor(state0, cursorAt(0, 4));

    const result = insertText(state, "`");

    const block = result.state.document.page.blocks[0];
    expect(block.type).toBe("paragraph");
    expect(getVisibleTextFromRuns((block as CodeBlock).charRuns)).toBe("hi```");
  });

  it("keeps backticks literal inside an existing code block", () => {
    // Typing "```" inside a code block must NOT wipe/re-convert it.
    const state0 = createInitialState(pageWith(codeBlock("``")));
    const state = withCursor(state0, cursorAt(0, 2));

    const result = insertText(state, "`");

    const block = result.state.document.page.blocks[0] as CodeBlock;
    expect(block.type).toBe("code");
    expect(getVisibleTextFromRuns(block.charRuns)).toBe("```");
  });
});

describe("CodeNode markdown round-trip", () => {
  it("round-trips a fenced code block with language and blank lines", () => {
    const md = "```js\nconst x = 1\n\nreturn x\n```";
    const page = loadPage(md);

    expect(page.blocks).toHaveLength(1);
    const block = page.blocks[0] as CodeBlock;
    expect(block.type).toBe("code");
    expect(block.language).toBe("js");
    expect(getVisibleTextFromRuns(block.charRuns)).toBe(
      "const x = 1\n\nreturn x",
    );
    expect(serializeToMarkdown(page.blocks)).toBe(md);
  });

  it("round-trips a fenced code block with no language", () => {
    const md = "```\na\nb\n```";
    const page = loadPage(md);

    const block = page.blocks[0] as CodeBlock;
    expect(block.type).toBe("code");
    expect(block.language).toBe("");
    expect(getVisibleTextFromRuns(block.charRuns)).toBe("a\nb");
    expect(serializeToMarkdown(page.blocks)).toBe(md);
  });

  it("keeps a code block and a following paragraph distinct", () => {
    const md = "```\ncode\n```\nafter";
    const page = loadPage(md);

    expect(page.blocks).toHaveLength(2);
    expect(page.blocks[0].type).toBe("code");
    expect(page.blocks[1].type).toBe("paragraph");
    expect(serializeToMarkdown(page.blocks)).toBe(md);
  });

  it("does not mistake inline `code` for a fenced block", () => {
    const page = loadPage("`x`");
    expect(page.blocks[0].type).toBe("paragraph");
  });

  it("emits markdown, HTML, and text for a code block", () => {
    const node = new CodeNode();
    const block = codeBlock("a < b\nc", "ts");

    expect(node.outputMarkdown(block)).toBe("```ts\na < b\nc\n```");
    expect(node.outputHTML(block)).toBe(
      '<pre><code class="language-ts">a &lt; b\nc</code></pre>',
    );
    expect(node.outputText(block)).toBe("a < b\nc");
  });
});

/**
 * Pins `atomicBlockInsertOps` — the descriptor-driven replacement for the old
 * per-type `createImageBlockOps` / `createLineBlockOps` / `createMathBlockOps`
 * paste closures. Asserts it emits exactly the block_insert + block_set ops the
 * hand-written versions did, so the generic field-driven path can't silently
 * drift from per-type behavior.
 */

import { mathTestSchema } from "../__testutils__/math";
import {
  type InlineMathHostBlock,
  resolveStructuredInlineMathRuns,
} from "../math/inline-structured";
import { moveCursorToPosition } from "../selection";
import type { Block, CharRun } from "../serlization/loadPage";
import { loadPage } from "../serlization/loadPage";
import type { BlockSet, EditorState } from "../state-types";
import { createInitialState } from "../state-utils";
import { getVisibleTextFromRuns } from "../sync/char-runs";
import { applyOps, getVisibleBlocks } from "../sync/reducer";
import { createCRDTbinding } from "../sync/sync";
import {
  atomicBlockInsertOps,
  getSelectionPlainText,
  pasteFromClipboardEvent,
  repairMathBackslashes,
} from "./clipboard";
import { describe, expect, it } from "vitest";

function setFields(block: Block): Record<string, unknown> {
  const binding = createCRDTbinding("page-1", "peer-a");
  const ops = atomicBlockInsertOps(block, "new-block", "after-block", binding);

  // First op is always the block_insert for the type.
  expect(ops[0]).toMatchObject({
    op: "block_insert",
    blockId: "new-block",
    orderKey: "after-block",
    blockType: block.type,
  });

  // The rest are block_sets; collapse to a field→value map for assertions.
  const fields: Record<string, unknown> = {};
  for (const op of ops.slice(1)) {
    expect(op.op).toBe("block_set");
    const set = op as BlockSet;
    expect(set.blockId).toBe("new-block");
    fields[set.field] = set.value;
  }
  return fields;
}

describe("atomicBlockInsertOps", () => {
  it("emits every set image property (url/alt/width/height/objectFit)", () => {
    const image = {
      id: "i1",
      orderKey: "a0",
      type: "image",
      url: "https://example.com/a.png",
      alt: "alt text",
      width: 200,
      height: 100,
      objectFit: "cover",
    } as unknown as Block;

    expect(setFields(image)).toEqual({
      url: "https://example.com/a.png",
      alt: "alt text",
      width: 200,
      height: 100,
      objectFit: "cover",
    });
  });

  it("omits unset image properties (only url present)", () => {
    const image = {
      id: "i2",
      orderKey: "a0",
      type: "image",
      url: "https://example.com/b.png",
    } as unknown as Block;

    // alt/width/height/objectFit are undefined → no block_set for them.
    expect(setFields(image)).toEqual({
      url: "https://example.com/b.png",
    });
  });

  // (Math does not paste through atomicBlockInsertOps: its content is a
  // structured attachment, so it travels as markdown in the clipboard marker
  // and re-imports as a fresh block-authority document.)

  it("emits only a block_insert for a line (no fields)", () => {
    const line = {
      id: "l1",
      orderKey: "a0",
      type: "line",
    } as unknown as Block;

    expect(setFields(line)).toEqual({});
  });
});

describe("multi-block paste — ordering & convergence", () => {
  const order = (p: { blocks: Block[] }) =>
    getVisibleBlocks(p as never).map((b) => b.id);

  it("local page matches replaying the emitted ops, with ascending keys", () => {
    const state = moveCursorToPosition(
      createInitialState(loadPage("Start\n")),
      0,
      5, // end of "Start"
    );
    const prevPage = state.document.page;

    const result = pasteFromClipboardEvent(state, {} as ClipboardEvent, {
      html: "<p>Alpha</p><p>Bravo</p><p>Charlie</p>",
      text: "",
      imageFile: null,
    });
    expect(result).not.toBeNull();

    // Convergence: a remote peer replaying the ops (or a rebuild from the log)
    // computes the SAME block order the local editor rendered — the historical
    // "pasted block teleported" bug class.
    const replayed = applyOps(prevPage, result!.ops);
    expect(order(result!.state.document.page)).toEqual(order(replayed));

    // More blocks than we started with, and every orderKey is strictly
    // ascending (no collisions that would scramble order).
    const blocks = getVisibleBlocks(result!.state.document.page);
    expect(blocks.length).toBeGreaterThan(1);
    const keys = blocks.map((b) => b.orderKey ?? "");
    for (let i = 1; i < keys.length; i++) {
      expect(keys[i - 1] < keys[i]).toBe(true);
    }
  });
});

describe("paste inside a quote — plain lines continue the quote", () => {
  const paste = (state: EditorState, text: string) =>
    pasteFromClipboardEvent(state, {} as ClipboardEvent, {
      html: "",
      text,
      imageFile: null,
    });
  const blockText = (b: Block) =>
    getVisibleTextFromRuns((b as { charRuns: CharRun[] }).charRuns);

  it("re-types pasted plain lines to quote blocks", () => {
    const state = moveCursorToPosition(
      createInitialState(loadPage("> Lead")),
      0,
      4, // end of "Lead"
    );
    const prevPage = state.document.page;

    const result = paste(state, "one\ntwo\nthree");
    expect(result).not.toBeNull();

    const blocks = getVisibleBlocks(result!.state.document.page);
    expect(blocks.map((b) => b.type)).toEqual(["quote", "quote", "quote"]);
    expect(blocks.map(blockText)).toEqual(["Leadone", "two", "three"]);

    // Convergence: replaying the emitted ops mints the same quote types.
    const replayed = applyOps(prevPage, result!.ops);
    expect(getVisibleBlocks(replayed).map((b) => b.type)).toEqual([
      "quote",
      "quote",
      "quote",
    ]);
  });

  it("keeps the host's tail in the quote when pasting mid-text", () => {
    const state = moveCursorToPosition(
      createInitialState(loadPage("> AliceBob")),
      0,
      5, // between "Alice" and "Bob"
    );

    const result = paste(state, "one\ntwo");
    const blocks = getVisibleBlocks(result!.state.document.page);

    expect(blocks.map((b) => b.type)).toEqual(["quote", "quote"]);
    expect(blocks.map(blockText)).toEqual(["Aliceone", "twoBob"]);
  });

  it("leaves richer parsed types (headings) untouched", () => {
    const state = moveCursorToPosition(
      createInitialState(loadPage("> Lead")),
      0,
      4,
    );

    const result = paste(state, "intro\n# Title\ntail");
    const blocks = getVisibleBlocks(result!.state.document.page);

    expect(blocks.map((b) => b.type)).toEqual(["quote", "heading1", "quote"]);
    expect(blocks.map(blockText)).toEqual(["Leadintro", "Title", "tail"]);
  });

  it("does not re-type lines pasted into a paragraph host", () => {
    const state = moveCursorToPosition(
      createInitialState(loadPage("Lead")),
      0,
      4,
    );

    const result = paste(state, "one\ntwo");
    const blocks = getVisibleBlocks(result!.state.document.page);

    expect(blocks.map((b) => b.type)).toEqual(["paragraph", "paragraph"]);
    expect(blocks.map(blockText)).toEqual(["Leadone", "two"]);
  });
});

describe("getSelectionPlainText", () => {
  // Select the whole document, mirroring how the engine extends a selection.
  function selectAll(markdown: string) {
    const page = loadPage(markdown);
    const state = createInitialState(page);
    const lastIndex = page.blocks.length - 1;
    const last = page.blocks[lastIndex];
    const lastLen =
      "charRuns" in last ? getVisibleTextFromRuns(last.charRuns).length : 0;
    return {
      ...state,
      document: {
        ...state.document,
        selection: {
          anchor: { blockIndex: 0, textIndex: 0 },
          focus: { blockIndex: lastIndex, textIndex: lastLen },
          isForward: true,
          isCollapsed: false,
        },
      },
    };
  }

  it("returns the empty string when nothing is selected", () => {
    expect(getSelectionPlainText(createInitialState(loadPage("Hello\n")))).toBe(
      "",
    );
  });

  it("projects a multi-block selection to plain text, stripping marks", () => {
    // Bold/italic markers must not survive into the plain-text mirror — it is
    // what a plain copy yields, and is produced without extracting formats.
    const text = getSelectionPlainText(
      selectAll("# Title\n\nA **bold** and *italic* line\n"),
    );
    expect(text).toContain("Title");
    expect(text).toContain("A bold and italic line");
    expect(text).not.toContain("**");
    expect(text).not.toContain("*italic*");
  });
});

describe("repairMathBackslashes", () => {
  // The defuddle/turndown HTML → Markdown path doubles every backslash and only
  // un-doubles a few non-backslash escapes, so pasted inline math arrives with
  // `\\degree` where the source had `\degree`. The math chip then renders the
  // stray backslash literally. Pin the repair so the chip's tree parses the
  // intended commands (import canonicalizes the source, e.g. `T_1` → `{T}_{1}`).
  const latexOf = (markdown: string) =>
    loadPage(
      repairMathBackslashes(markdown),
      mathTestSchema.data,
    ).blocks.flatMap((b) =>
      resolveStructuredInlineMathRuns(b as never as InlineMathHostBlock).map(
        (run) => run.latex,
      ),
    );

  it("collapses doubled backslashes inside inline math (turndown artifact)", () => {
    // `$T_1=100\degree C$` round-trips through turndown as `\\degree`.
    expect(repairMathBackslashes("- $T_1=100\\\\degree C = 373.15 K$")).toBe(
      "- $T_1=100\\degree C = 373.15 K$",
    );
    expect(latexOf("- $T_1=100\\\\degree C = 373.15 K$")).toEqual([
      "{T}_{1}=100\\degree C=373.15K",
    ]);
    expect(latexOf("$Q=\\\\boxed{}$")).toEqual(["Q=\\boxed{}"]);
  });

  it("repairs block math the same way and never crosses the $$ pair", () => {
    expect(repairMathBackslashes("$$\n\\\\frac{a}{b}\n$$")).toBe(
      "$$\n\\frac{a}{b}\n$$",
    );
  });

  it("preserves a genuine LaTeX row break (turndown sends `\\\\` as `\\\\\\\\`)", () => {
    // A real `\\` row break is doubled by turndown to four backslashes; the
    // repair must leave exactly the two-backslash row break behind.
    expect(repairMathBackslashes("$a\\\\\\\\b$")).toBe("$a\\\\b$");
  });

  it("leaves non-math text and backslash-free math untouched", () => {
    expect(repairMathBackslashes("a \\\\ b and $x=1$")).toBe(
      "a \\\\ b and $x=1$",
    );
  });
});

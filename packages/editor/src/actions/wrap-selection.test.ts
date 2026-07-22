/**
 * Selection wrapping — typing a delimiter over a held selection encloses it
 * (VS Code auto-surround) instead of replacing it. Brackets/quotes wrap
 * literally; a markdown delimiter applies its mark (`*` → emphasis, `**` →
 * strong, `` ` `` → code, `$` → math, `~` → strike). See `wrap-selection.ts`.
 */

import { mathTestSchema, mathTestStateOptions } from "../__testutils__/math";
import { STRUCTURED_MARK_ANCHOR_CHAR } from "../feature-facets";
import { loadPage } from "../serlization/loadPage";
import { serializeToMarkdown } from "../serlization/serializer";
import type { EditorState, Position } from "../state-types";
import { createInitialState } from "../state-utils";
import { getVisibleTextFromRuns } from "../sync/char-runs";
import { allCharsHaveFormat } from "../sync/crdt-utils";
import { insertText } from "./actions";
import { describe, expect, it } from "vitest";

/** State over `markdown` with `[anchor, focus]` selected and the caret at focus. */
function stateWithSelection(
  markdown: string,
  anchor: Position,
  focus: Position,
): EditorState {
  const state = createInitialState(
    loadPage(markdown, mathTestSchema.data),
    mathTestStateOptions(),
  );
  return {
    ...state,
    document: {
      ...state.document,
      cursor: { position: focus, lastUpdate: 0 },
      selection: {
        anchor,
        focus,
        isForward:
          anchor.blockIndex < focus.blockIndex ||
          (anchor.blockIndex === focus.blockIndex &&
            anchor.textIndex <= focus.textIndex),
        isCollapsed: false,
      },
    },
  };
}

function at(blockIndex: number, textIndex: number): Position {
  return { blockIndex, textIndex };
}

function blockText(state: EditorState, blockIndex: number): string {
  const block = state.document.page.blocks[blockIndex];
  if (!("charRuns" in block)) throw new Error("not a textual block");
  return getVisibleTextFromRuns(block.charRuns);
}

function rangeHasFormat(
  state: EditorState,
  blockIndex: number,
  from: number,
  to: number,
  type: string,
): boolean {
  const block = state.document.page.blocks[blockIndex];
  if (!("charRuns" in block)) throw new Error("not a textual block");
  return allCharsHaveFormat(block.charRuns, block.formats, from, to, type);
}

function type(state: EditorState, char: string) {
  return insertText(state, char, { wrapSelection: true });
}

describe("literal pair wrapping", () => {
  it("wraps the selection in parens and re-selects the content", () => {
    // "hello world" with "world" selected
    const state = stateWithSelection("hello world\n", at(0, 6), at(0, 11));
    const { state: next, ops } = type(state, "(");

    expect(blockText(next, 0)).toBe("hello (world)");
    expect(next.document.selection).toMatchObject({
      anchor: { blockIndex: 0, textIndex: 7 },
      focus: { blockIndex: 0, textIndex: 12 },
      isCollapsed: false,
    });
    expect(next.document.cursor?.position).toEqual(at(0, 12));
    expect(ops.length).toBe(2); // one insert per side
  });

  it("wraps with brackets, braces, and quotes", () => {
    const base = () => stateWithSelection("abc\n", at(0, 0), at(0, 3));
    expect(blockText(type(base(), "[").state, 0)).toBe("[abc]");
    expect(blockText(type(base(), "{").state, 0)).toBe("{abc}");
    expect(blockText(type(base(), '"').state, 0)).toBe('"abc"');
    expect(blockText(type(base(), "'").state, 0)).toBe("'abc'");
  });

  it("preserves a backward selection's direction", () => {
    // Anchor after focus (selected right-to-left).
    const state = stateWithSelection("hello world\n", at(0, 11), at(0, 6));
    const { state: next } = type(state, "(");

    expect(blockText(next, 0)).toBe("hello (world)");
    expect(next.document.selection).toMatchObject({
      anchor: { blockIndex: 0, textIndex: 12 },
      focus: { blockIndex: 0, textIndex: 7 },
    });
    expect(next.document.cursor?.position).toEqual(at(0, 7));
  });

  it("wraps a multi-block selection across its two end blocks", () => {
    const state = stateWithSelection("alpha\nbeta\n", at(0, 2), at(1, 3));
    const { state: next } = type(state, "(");

    expect(blockText(next, 0)).toBe("al(pha");
    expect(blockText(next, 1)).toBe("bet)a");
    expect(next.document.selection).toMatchObject({
      anchor: { blockIndex: 0, textIndex: 3 },
      focus: { blockIndex: 1, textIndex: 3 },
    });
  });

  it("wraps literally inside a code block, where no mark can apply", () => {
    // A fenced block: marks are off (hasFormats: false), so `(` and even
    // backtick wrap as literal characters.
    const state = stateWithSelection("```\nvalue\n```\n", at(0, 2), at(0, 5));
    expect(blockText(type(state, "(").state, 0)).toBe("va(lue)");
    expect(blockText(type(state, "`").state, 0)).toBe("va`lue`");
  });

  it("still replaces the selection for a non-trigger character", () => {
    const state = stateWithSelection("hello world\n", at(0, 6), at(0, 11));
    const { state: next } = type(state, "x");
    expect(blockText(next, 0)).toBe("hello x");
  });

  it("keeps replace semantics when the caller does not opt in", () => {
    const state = stateWithSelection("hello world\n", at(0, 6), at(0, 11));
    const { state: next } = insertText(state, "(");
    expect(blockText(next, 0)).toBe("hello (");
  });
});

describe("markdown delimiter wrapping (marks)", () => {
  it("applies emphasis for `*` without inserting any character", () => {
    const state = stateWithSelection("hello world\n", at(0, 6), at(0, 11));
    const { state: next, ops } = type(state, "*");

    expect(blockText(next, 0)).toBe("hello world");
    expect(rangeHasFormat(next, 0, 6, 11, "emphasis")).toBe(true);
    expect(ops.length).toBe(1);
    // Selection is held so the next press can advance the cycle.
    expect(next.document.selection).toMatchObject({
      anchor: { blockIndex: 0, textIndex: 6 },
      focus: { blockIndex: 0, textIndex: 11 },
    });
  });

  it("walks the `*` delimiter cycle: em → strong → both → plain", () => {
    let state = stateWithSelection("hello world\n", at(0, 6), at(0, 11));

    state = type(state, "*").state; // `*` → emphasis
    expect(rangeHasFormat(state, 0, 6, 11, "emphasis")).toBe(true);
    expect(rangeHasFormat(state, 0, 6, 11, "strong")).toBe(false);

    state = type(state, "*").state; // `**` → strong
    expect(rangeHasFormat(state, 0, 6, 11, "emphasis")).toBe(false);
    expect(rangeHasFormat(state, 0, 6, 11, "strong")).toBe(true);

    state = type(state, "*").state; // `***` → both
    expect(rangeHasFormat(state, 0, 6, 11, "emphasis")).toBe(true);
    expect(rangeHasFormat(state, 0, 6, 11, "strong")).toBe(true);

    state = type(state, "*").state; // fourth press → plain
    expect(rangeHasFormat(state, 0, 6, 11, "emphasis")).toBe(false);
    expect(rangeHasFormat(state, 0, 6, 11, "strong")).toBe(false);
    expect(blockText(state, 0)).toBe("hello world"); // never any literal `*`
  });

  it("upgrades an already-bold selection to bold+italic on `*`", () => {
    let state = stateWithSelection("**bold**\n", at(0, 0), at(0, 4));
    expect(rangeHasFormat(state, 0, 0, 4, "strong")).toBe(true);

    state = type(state, "*").state;
    expect(rangeHasFormat(state, 0, 0, 4, "strong")).toBe(true);
    expect(rangeHasFormat(state, 0, 0, 4, "emphasis")).toBe(true);
  });

  it("treats `_` like `*`", () => {
    let state = stateWithSelection("word\n", at(0, 0), at(0, 4));
    state = type(state, "_").state;
    expect(rangeHasFormat(state, 0, 0, 4, "emphasis")).toBe(true);
    state = type(state, "_").state;
    expect(rangeHasFormat(state, 0, 0, 4, "strong")).toBe(true);
  });

  it("toggles code with a backtick", () => {
    let state = stateWithSelection("word\n", at(0, 0), at(0, 4));
    state = type(state, "`").state;
    expect(rangeHasFormat(state, 0, 0, 4, "code")).toBe(true);
    expect(blockText(state, 0)).toBe("word");
    state = type(state, "`").state;
    expect(rangeHasFormat(state, 0, 0, 4, "code")).toBe(false);
  });

  it("toggles strike with `~`", () => {
    let state = stateWithSelection("word\n", at(0, 0), at(0, 4));
    state = type(state, "~").state;
    expect(rangeHasFormat(state, 0, 0, 4, "strike")).toBe(true);
    state = type(state, "~").state;
    expect(rangeHasFormat(state, 0, 0, 4, "strike")).toBe(false);
  });

  it("collapses the selection to an atomic math chip on `$`", () => {
    // Math is a structured mark: the selected source becomes a new
    // attachment and the flat range is REPLACED by one anchor char.
    let state = stateWithSelection("E = mc^2\n", at(0, 4), at(0, 8));
    state = type(state, "$").state;
    expect(blockText(state, 0)).toBe(`E = ${STRUCTURED_MARK_ANCHOR_CHAR}`);
    expect(rangeHasFormat(state, 0, 4, 5, "math")).toBe(true);
    // The captured source lives on canonically in the attachment.
    expect(
      serializeToMarkdown(state.document.page.blocks, undefined, {
        schema: mathTestSchema.data,
      }),
    ).toBe("E = $m{c}^{2}$");
    // The selection covers the chip so a second `$` is claimed — but it must
    // not double-wrap or corrupt the existing structured run.
    const again = type(state, "$");
    expect(again.ops).toEqual([]);
    expect(blockText(again.state, 0)).toBe(
      `E = ${STRUCTURED_MARK_ANCHOR_CHAR}`,
    );
    expect(rangeHasFormat(again.state, 0, 4, 5, "math")).toBe(true);
  });

  it("completes a partially-marked selection instead of toggling it off", () => {
    // "*it*alic": only the first two chars are emphasized.
    let state = stateWithSelection("*it*alic\n", at(0, 0), at(0, 6));
    expect(rangeHasFormat(state, 0, 0, 2, "emphasis")).toBe(true);
    expect(rangeHasFormat(state, 0, 0, 6, "emphasis")).toBe(false);

    state = type(state, "*").state;
    expect(rangeHasFormat(state, 0, 0, 6, "emphasis")).toBe(true);
  });

  it("marks every text slice of a multi-block selection", () => {
    let state = stateWithSelection("alpha\nbeta\n", at(0, 2), at(1, 3));
    state = type(state, "*").state;

    expect(rangeHasFormat(state, 0, 2, 5, "emphasis")).toBe(true);
    expect(rangeHasFormat(state, 1, 0, 3, "emphasis")).toBe(true);
    expect(rangeHasFormat(state, 0, 0, 2, "emphasis")).toBe(false);
    expect(rangeHasFormat(state, 1, 3, 4, "emphasis")).toBe(false);
  });

  it("replaces the selection with `*` inside a code block (no mark, no pair)", () => {
    const state = stateWithSelection("```\nvalue\n```\n", at(0, 2), at(0, 5));
    const { state: next } = type(state, "*");
    expect(blockText(next, 0)).toBe("va*");
  });
});

describe("pair wrapping around math chips", () => {
  // A chip is atomic to the flat model — the formula's interior is only
  // reachable through nested content selections, so the only flat selection
  // touching math is one that covers the whole anchor char.

  it("keeps raw braces for a whole-chip selection (endpoints outside the formula)", () => {
    // "a $x+1$ b" projects to "a ￼ b"; the chip is the single char at [2, 3).
    const state = stateWithSelection("a $x+1$ b\n", at(0, 2), at(0, 3));
    const { state: next } = type(state, "{");

    expect(blockText(next, 0)).toBe(`a {${STRUCTURED_MARK_ANCHOR_CHAR}} b`);
    // The chip itself is untouched; the braces are plain text around it.
    expect(rangeHasFormat(next, 0, 3, 4, "math")).toBe(true);
    expect(rangeHasFormat(next, 0, 2, 3, "math")).toBe(false);
    expect(rangeHasFormat(next, 0, 4, 5, "math")).toBe(false);
    expect(
      serializeToMarkdown(next.document.page.blocks, undefined, {
        schema: mathTestSchema.data,
      }),
    ).toBe("a {$x+1$} b");
  });
});

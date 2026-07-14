/**
 * Typing a construct in a math block materializes its placeholder slots as part
 * of the same edit. A bare `\frac` has no source text between its numerator and
 * denominator, so both collapse to one caret offset and arrow nav can't enter
 * either — completing the command auto-inserts `\frac{}{}` (real CRDT chars, so
 * each slot gets a distinct offset) and drops the caret in the numerator, exactly
 * like picking the construct from the `\` command menu. Idempotent: typing inside
 * an already-braced construct never adds more braces.
 */
import { mathTestStateOptions } from "../__testutils__/math";
import type { MathBlock } from "../nodes/MathNode";
import type { Page } from "../serlization/loadPage";
import type { CursorState, EditorState } from "../state-types";
import { createInitialState } from "../state-utils";
import { getVisibleTextFromRuns } from "../sync/char-runs";
import { insertText } from "./actions";
import { describe, expect, it } from "vitest";

function mathBlock(latex: string): MathBlock {
  return {
    id: "m-1",
    orderKey: "a0",
    deleted: false,
    type: "math",
    charRuns: latex ? [{ peerId: "peer", startCounter: 0, text: latex }] : [],
    formats: [],
    displayMode: true,
  };
}

function stateWith(latex: string, caret: number): EditorState {
  const page: Page = { id: "page-1", title: "t", blocks: [mathBlock(latex)] };
  const s0 = createInitialState(page, mathTestStateOptions());
  const cursor: CursorState = {
    position: { blockIndex: 0, textIndex: caret },
    lastUpdate: 0,
  };
  return { ...s0, document: { ...s0.document, cursor } };
}

function text(s: EditorState) {
  return getVisibleTextFromRuns(s.document.page.blocks[0].charRuns ?? []);
}

describe("math construct materialization on type", () => {
  it("completes `\\frac` into `\\frac{}{}` and lands the caret in the numerator", () => {
    // Caret at the end of a half-typed `\fra`; the `c` completes the command.
    const { state } = insertText(stateWith("\\fra", 4), "c");
    expect(text(state)).toBe("\\frac{}{}");
    expect(state.document.cursor?.position.textIndex).toBe(6); // inside first {}
  });

  it("materializes via real ops (so the braces sync, not just the local view)", () => {
    const { ops } = insertText(stateWith("\\fra", 4), "c");
    // The typed `c` plus the inserted braces are all CRDT text-insert ops.
    const inserted = ops
      .filter((o) => o.op === "text_insert")
      .flatMap((o) => (o as { charRuns: { text: string }[] }).charRuns)
      .map((r) => r.text)
      .join("");
    expect(inserted).toContain("{}{}");
  });

  it("fills a missing denominator after the numerator is closed", () => {
    // Typing the `}` that closes the numerator leaves the denominator empty.
    const { state } = insertText(stateWith("\\frac{a", 7), "}");
    expect(text(state)).toBe("\\frac{a}{}");
    expect(state.document.cursor?.position.textIndex).toBe(9); // inside the new {}
  });

  it("is idempotent — typing inside a braced slot adds no extra braces", () => {
    // Caret in the (empty) numerator of an already-materialized fraction.
    const { state } = insertText(stateWith("\\frac{}{}", 6), "a");
    expect(text(state)).toBe("\\frac{a}{}");
    expect(state.document.cursor?.position.textIndex).toBe(7);
  });

  it("leaves a complete, argument-less command alone", () => {
    const { state } = insertText(stateWith("\\alph", 5), "a");
    expect(text(state)).toBe("\\alpha");
    expect(state.document.cursor?.position.textIndex).toBe(6);
  });
});

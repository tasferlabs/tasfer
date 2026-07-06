/**
 * Regression corpus — math source corruption when typing `\text`/command
 * arguments and brackets. Types sequences char-by-char through the REAL
 * insertText pipeline (mathTransformTypedInput → insert → balance → materialize
 * → separator drop) into various host formulas and asserts the resulting source
 * is not corrupted. Each `expected` is the sane, non-corrupting output; the
 * `pre-fix:` comments record the corruption these cases reproduced before Phase 0.
 */
import { insertText } from "./actions/actions";
import { mathMatrixContext } from "./nodes/math";
import { moveCursorToPosition } from "./selection";
import type { EditorState } from "./state-types";
import { createInitialState } from "./state-utils";
import { getVisibleTextFromRuns } from "./sync/char-runs";
import { insertCharsAtPosition } from "./sync/crdt-utils";
import { createCRDTbinding, createSyncEngine } from "./sync/sync";
import { describe, expect, it } from "vitest";

/** A block-equation editor state holding `latex`, with the caret at `caret`. */
function mathState(latex: string, caret: number) {
  const binding = createCRDTbinding("repro-text-brackets", "peer-1");
  const engine = createSyncEngine(binding);
  const blockOp = engine.createBlockInsert(null, "math", { displayMode: true });
  engine.emit([blockOp]);
  const blockId = blockOp.blockId;

  let page = engine.getState();
  if (latex) {
    page = insertCharsAtPosition(page, blockId, 0, latex, binding).newPage;
  }
  let state = createInitialState(page, { crdtBinding: binding });
  state = moveCursorToPosition(state, 0, caret);
  return { state, blockId };
}

function latexOf(state: EditorState, blockIndex = 0) {
  return getVisibleTextFromRuns(
    state.document.page.blocks[blockIndex].charRuns,
  );
}

/** Type `seq` char by char into `host` at `caret`; return the final source. */
function typeSeq(host: string, caret: number, seq: string): string {
  let { state } = mathState(host, caret);
  for (const ch of seq) {
    state = insertText(state, ch).state;
  }
  return latexOf(state);
}

interface Case {
  name: string;
  host: string;
  caret: number;
  seq: string;
  /** What a non-corrupting editor would plausibly produce. */
  expected: string;
}

const CASES: Case[] = [
  // ── Controls (empty host / caret at end — known-good per existing tests) ──
  {
    name: "control: empty host, \\text{hi}",
    host: "",
    caret: 0,
    seq: "\\text{hi}",
    expected: "\\text{hi}",
  },
  {
    name: "control: caret at end of x+y, \\text{hi}",
    host: "x+y",
    caret: 3,
    seq: "\\text{hi}",
    expected: "x+y\\text{hi}",
  },
  // ── Mid-formula: content AFTER the caret ──
  {
    name: "caret at 0 of x+y, type \\text{",
    host: "x+y",
    caret: 0,
    seq: "\\text{",
    expected: "\\text{}x+y", // ACTUAL: "\\text{x+y}"
  },
  {
    name: "caret at 0 of x+y, type \\text{hi}",
    host: "x+y",
    caret: 0,
    seq: "\\text{hi}",
    expected: "\\text{hi}x+y", // ACTUAL: "\\text{hi\\}x+y}"
  },
  {
    name: "frac numerator: \\frac{a|}{b} type \\text{",
    host: "\\frac{a}{b}",
    caret: 7,
    seq: "\\text{",
    expected: "\\frac{a\\text{}}{b}", // ACTUAL: "\\frac{a\\text{}{b}}{}"
  },
  {
    name: "frac numerator: \\frac{a|}{b} type \\text{hi}",
    host: "\\frac{a}{b}",
    caret: 7,
    seq: "\\text{hi}",
    expected: "\\frac{a\\text{hi}}{b}", // ACTUAL: "\\frac{a\\text{hi}{b}}{}"
  },
  {
    name: "empty frac numerator: \\frac{|}{b} type \\text{hi}",
    host: "\\frac{}{b}",
    caret: 6,
    seq: "\\text{hi}",
    expected: "\\frac{\\text{hi}}{b}", // ACTUAL: "\\frac{\\text{hi}{b}}{}"
  },
  // ── \text before existing content that starts with a letter ──
  {
    name: "caret before ab: |ab+c type \\text{",
    host: "ab+c",
    caret: 0,
    seq: "\\text{",
    expected: "\\text{}ab+c", // ACTUAL: "\\text{ab+c}"
  },
  // ── Matrix cell ──
  {
    name: "matrix cell: a|&b type \\text",
    host: "\\begin{matrix}a&b\\end{matrix}",
    caret: "\\begin{matrix}a".length,
    // The `&` survives as a column separator (parseRawTextArg no longer eats it),
    // so the matrix stays 2 columns. The protective separator space collapses.
    seq: "\\text",
    expected: "\\begin{matrix}a\\text&b\\end{matrix}", // pre-fix: "…a\\text&b…" parsed as 1 cell
  },
  {
    name: "matrix cell: a|&b type \\text{hi}",
    host: "\\begin{matrix}a&b\\end{matrix}",
    caret: "\\begin{matrix}a".length,
    seq: "\\text{hi}",
    expected: "\\begin{matrix}a\\text{hi}&b\\end{matrix}", // ACTUAL: "\\begin{matrix}a\\text{hi\\}&b\\end{matrix}}"
  },
  // ── Brackets around \text ──
  // NOTE: typing inside a `\sqrt[…]` optional index is a KNOWN-REMAINING residual
  // (a distinct mechanism from the four Phase 0 fixes) — see the it.fails block
  // at the end of this file.
  {
    name: "after \\text{hi}, type [a]",
    host: "\\text{hi}",
    caret: 9,
    seq: "[a]",
    expected: "\\text{hi}[a]", // passes
  },
  {
    name: "inside \\text{h|i}, type [",
    host: "\\text{hi}",
    caret: 7,
    seq: "[",
    expected: "\\text{h[i}", // passes
  },
  {
    name: "inside \\text{h|i}, type {",
    host: "\\text{hi}",
    caret: 7,
    seq: "{",
    expected: "\\text{h\\{i}", // passes
  },
  // ── \text-family sibling (\textrm; whole TEXT_FONTS family affected) ──
  {
    name: "caret at 0 of x+y, type \\textrm{",
    host: "x+y",
    caret: 0,
    seq: "\\textrm{",
    expected: "\\textrm{}x+y", // ACTUAL: "\\textrm{x+y}"
  },
  // ── \text then brace with caret inside existing \text body start ──
  {
    name: "\\text{|hi}: type { (escape into body)",
    host: "\\text{hi}",
    caret: 6,
    seq: "{",
    expected: "\\text{\\{hi}", // passes
  },
];

describe("repro: \\text + braces/brackets corruption", () => {
  for (const c of CASES) {
    it(c.name, () => {
      const actual = typeSeq(c.host, c.caret, c.seq);

      console.log(
        `CASE: ${c.name}\n  host=${JSON.stringify(c.host)} caret=${c.caret} seq=${JSON.stringify(c.seq)}\n  actual=${JSON.stringify(actual)}\n  expect=${JSON.stringify(c.expected)}`,
      );
      expect(actual).toBe(c.expected);
    });
  }

  it("MINIMAL: any raw { typed after a command intro swallows trailing content", () => {
    // Host `+`, caret 0. Three keystrokes: `\`, `t`, `{`. The `{` passes through
    // raw (afterCommandIntro), balanceBraces appends the healing `}` at the END
    // of the source, so the user's `+` is swallowed into the new group.
    const actual = typeSeq("+", 0, "\\t{");

    console.log(`MINIMAL actual=${JSON.stringify(actual)}`);
    expect(actual).toBe("\\t{}+"); // empty slot at caret, `+` untouched — pre-fix: "\\t{+}"
  });

  it("ORACLE: matrix keeps 2 columns after typing \\text in a cell", () => {
    const final = typeSeq(
      "\\begin{matrix}a&b\\end{matrix}",
      "\\begin{matrix}a".length,
      "\\text",
    );
    const ctx = mathMatrixContext(final, "\\begin{matrix}a".length);
    expect(ctx?.cols).toBe(2); // `&` must survive as a column separator — pre-fix: cols 1 (cells merged)
  });
});

// A `\sqrt[…]` optional index is a distinct mechanism the four Phase 0 fixes do
// NOT cover: typing a command/argument inside the index (or completing the
// command there) mis-nests the radicand and strands a spurious empty `{}` group
// after the construct. Non-corrupting content-wise (the radicand `x` survives)
// but structurally messy. Tracked here so it is not silently dropped; remove the
// `.fails` marker when a follow-up fixes the optional-index path.
describe("KNOWN REMAINING: \\sqrt[…] optional-index editing", () => {
  it.fails("typing \\text{h} in a \\sqrt index leaves no stray group", () => {
    expect(typeSeq("\\sqrt[3]{x}", 7, "\\text{h}")).toBe(
      "\\sqrt[3\\text{h}]{x}",
    );
  });
});

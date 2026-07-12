/**
 * Typing text the math fonts can't render (CJK, Japanese, …) into math wraps it
 * in a `\text{…}` run instead of dropping it as a latent glyph — so an IME
 * commit lands visibly in a formula and the host font typesets it. Merges into
 * an adjacent `\text{…}` so consecutive bursts don't stack empty wrappers.
 *
 * These pin `mathTransformTypedInput`'s rewrite (pure over the block); the render
 * side (`\text` typesetting via the host font) is covered in `@cypherkit/tex`.
 */
import { createMathTestSyncEngine } from "./__testutils__/math";
import { mathDeleteUnit, mathTransformTypedInput } from "./nodes/math";
import type { Block } from "./serlization/loadPage";
import { insertCharsAtPosition, markCharsInRange } from "./sync/crdt-utils";
import { createCRDTbinding } from "./sync/sync";
import { describe, expect, it } from "vitest";

/** A display math block whose char-run text IS `latex`. */
function mathBlock(latex: string): Block {
  const binding = createCRDTbinding("wrap", "peer-1");
  const engine = createMathTestSyncEngine(binding);
  const op = engine.createBlockInsert(null, "math", { displayMode: true });
  engine.emit([op]);
  const page = insertCharsAtPosition(
    engine.getState(),
    op.blockId,
    0,
    latex,
    binding,
  ).newPage;
  return page.blocks[0];
}

/** A paragraph with an inline-math chip `latex` at `[start, start+latex.length]`,
 *  optional plain text before/after. */
function chipBlock(before: string, latex: string, after = ""): Block {
  const binding = createCRDTbinding("wrap", "peer-1");
  const engine = createMathTestSyncEngine(binding);
  const op = engine.createBlockInsert(null, "paragraph", {});
  engine.emit([op]);
  const id = op.blockId;
  let page = insertCharsAtPosition(
    engine.getState(),
    id,
    0,
    before + latex + after,
    binding,
  ).newPage;
  page = markCharsInRange(
    page,
    id,
    before.length,
    before.length + latex.length,
    { type: "math" },
    true,
    binding,
  ).newPage;
  return page.blocks[0];
}

describe("typing CJK into a block equation wraps it in \\text", () => {
  it("wraps a single ideograph at the caret", () => {
    const block = mathBlock("x+y");
    expect(mathTransformTypedInput(block, 3, "中")).toEqual({
      input: "\\text{中}",
      insertAt: 3,
      caret: 3 + "\\text{中}".length,
    });
  });

  it("wraps a whole IME commit (multi-char burst) in one \\text", () => {
    const block = mathBlock("x+y");
    expect(mathTransformTypedInput(block, 3, "中文")).toEqual({
      input: "\\text{中文}",
      insertAt: 3,
      caret: 3 + "\\text{中文}".length,
    });
  });

  it("leaves a plain math keystroke untouched (no wrap)", () => {
    const block = mathBlock("x+y");
    expect(mathTransformTypedInput(block, 3, "x")).toBeNull();
  });

  it("does NOT wrap a mixed math+text insert (falls through)", () => {
    const block = mathBlock("x+y");
    // 'a' is math-renderable → not an all-text burst → math path (drops '中').
    const out = mathTransformTypedInput(block, 3, "a中");
    expect(out).not.toBeNull();
    expect(out!.input).not.toContain("\\text");
  });
});

describe("merging into an adjacent \\text run", () => {
  it("extends the run when the caret sits inside its body", () => {
    // "\text{中}": body chars 6..6 (中), '}' at index 7.
    const block = mathBlock("\\text{中}");
    expect(mathTransformTypedInput(block, 7, "文")).toEqual({
      input: "文",
      insertAt: 7,
      caret: 8,
    });
  });

  it("extends the run when the caret sits just after its closing brace", () => {
    const block = mathBlock("\\text{中}");
    // Caret at 8 (after '}') → insert before '}' at index 7, so it stays inside.
    expect(mathTransformTypedInput(block, 8, "文")).toEqual({
      input: "文",
      insertAt: 7,
      caret: 8,
    });
  });
});

describe("wrapping inside an inline chip (block-coordinate mapping)", () => {
  it("wraps at the chip-strict-inside caret and remaps to block indices", () => {
    // "a" + chip "\alpha" at [1,7]; caret at block index 4 (strictly inside).
    const block = chipBlock("a", "\\alpha");
    const out = mathTransformTypedInput(block, 4, "中");
    // chip-local offset 3 → wrap "\text{中}" at local 3, remapped by +1 (chip start).
    expect(out).toEqual({
      input: "\\text{中}",
      insertAt: 4,
      caret: 4 + "\\text{中}".length,
      suppressMarkdown: true,
    });
  });
});

describe("deleting inside a \\text run peels one char, not the whole run", () => {
  // Counterpart to the wrap tests: once text lives in a `\text{…}` run, a
  // Backspace/Delete must chip a single code point off it (matching what the
  // caret can land between) rather than selecting and wiping the entire run.
  it("Backspace removes the char before the caret (LTR block)", () => {
    // "\text{abc}": letters at 6,7,8; Backspace at offset 8 removes `b` [7,8).
    const block = mathBlock("\\text{abc}");
    expect(mathDeleteUnit(block, 8, "backward")).toEqual({
      from: 7,
      to: 8,
      isConstruct: false,
    });
  });

  it("Delete removes the char after the caret (LTR block)", () => {
    const block = mathBlock("\\text{abc}");
    expect(mathDeleteUnit(block, 7, "forward")).toEqual({
      from: 7,
      to: 8,
      isConstruct: false,
    });
  });

  it("Arabic (RTL): Backspace deletes the logically-previous char", () => {
    // "\text{عربي}": ع ر ب ي at 6,7,8,9. Backspace at offset 8 removes ر [7,8) —
    // the source-order-previous char — not the whole run, and not the neighbour
    // on the caret's visual left.
    const block = mathBlock("\\text{عربي}");
    expect(mathDeleteUnit(block, 8, "backward")).toEqual({
      from: 7,
      to: 8,
      isConstruct: false,
    });
    // The final logical char ي [9,10) (screen-leftmost) is what Backspace at the
    // run's logical end (offset 10) removes.
    expect(mathDeleteUnit(block, 10, "backward")).toEqual({
      from: 9,
      to: 10,
      isConstruct: false,
    });
  });

  it("emptying the run then deleting again removes the whole \\text{}", () => {
    // "\text{ي}": one letter at [6,7). Backspace at 7 peels it (→ `\text{}`);
    // a further Backspace at the now-empty body (offset 6) has no char to peel,
    // so it escalates to remove the whole empty wrapper.
    expect(mathDeleteUnit(mathBlock("\\text{ي}"), 7, "backward")).toEqual({
      from: 6,
      to: 7,
      isConstruct: false,
    });
    expect(mathDeleteUnit(mathBlock("\\text{}"), 6, "backward")).toEqual({
      from: 0,
      to: 7,
      isConstruct: true,
    });
  });

  it("peels a char inside a \\text run within an inline chip", () => {
    // chip "\text{عرب}" at [0,10]; ع ر ب at chip-local 6,7,8. Backspace at block
    // index 8 (chip-local 8) removes ر [7,8), remapped to block coordinates.
    const block = chipBlock("", "\\text{عرب}");
    expect(mathDeleteUnit(block, 8, "backward")).toEqual({
      from: 7,
      to: 8,
      isConstruct: false,
    });
  });
});

describe("content typed just past an EMPTY slot fills it, not the baseline", () => {
  // The caret one stop past an empty `{}` (a stop that exists so it can step out
  // of the slot, sitting visually almost on top of the interior for a zero-width
  // empty box) used to drop content beside the box, stranding the placeholder
  // (`x^{}中`). Content is now redirected INTO the slot.
  it("wraps CJK into an empty superscript (`x^{}|` + 中 → `x^{\\text{中}}`)", () => {
    const block = mathBlock("x^{}"); // interior 3, ']}' at 3, caret past it at 4
    expect(mathTransformTypedInput(block, 4, "中")).toEqual({
      input: "\\text{中}",
      insertAt: 3,
      caret: 3 + "\\text{中}".length,
    });
  });

  it("fills an empty subscript with a plain math char (`x_{}|` + a → `x_{a}`)", () => {
    const block = mathBlock("x_{}");
    expect(mathTransformTypedInput(block, 4, "a")).toEqual({
      input: "a",
      insertAt: 3,
      caret: 4,
    });
  });

  it("fills an empty radicand (`\\sqrt{}|` + 中 → `\\sqrt{\\text{中}}`)", () => {
    const block = mathBlock("\\sqrt{}"); // interior 6, caret past `}` at 7
    expect(mathTransformTypedInput(block, 7, "中")).toEqual({
      input: "\\text{中}",
      insertAt: 6,
      caret: 6 + "\\text{中}".length,
    });
  });

  it("does NOT redirect a structural keystroke — `^` still attaches to the base", () => {
    const block = mathBlock("x^{}");
    // `^` owns its own script-attach handling; it must not nest inside the slot.
    const out = mathTransformTypedInput(block, 4, "^");
    expect(out?.insertAt).not.toBe(3);
  });

  it("redirects into an empty slot inside a chip too", () => {
    // chip "\sqrt{}z" at [0,8]; the empty `{}` is [5,7), z follows. Caret at block
    // index 7 (between `}` and z) is strictly inside the chip AND just past the slot.
    const block = chipBlock("", "\\sqrt{}z");
    const out = mathTransformTypedInput(block, 7, "中");
    // local offset 7 is past the empty `{}`; redirect to interior local 6.
    expect(out).toEqual({
      input: "\\text{中}",
      insertAt: 6,
      caret: 6 + "\\text{中}".length,
      suppressMarkdown: true,
    });
  });
});

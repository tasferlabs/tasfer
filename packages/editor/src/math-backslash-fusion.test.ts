/**
 * Regression corpus — math source corruption when typing a backslash (or slash)
 * before existing content. A typed `\` must not fuse with the adjacent character
 * into a command that swallows it.
 *
 * Drives the REAL editor typing path (insertText → mathTransformTypedInput →
 * separator/heal/materialize pipeline) char-by-char, at every *user-reachable
 * caret stop* of a set of host formulas, and checks corruption oracles on the
 * resulting LaTeX source:
 *   - all original leaf atoms (chars) still parse out of the final source
 *   - structural node counts (frac/sqrt/supsub/text/array) don't decrease
 *   - after typing a COMPLETE command (`\pi`), no `unknown` node exists and
 *     the π glyph actually typesets
 */
import {
  createMathTestState,
  createMathTestSyncEngine,
} from "./__testutils__/math";
import { insertText } from "./actions/actions";
import { moveCursorToPosition } from "./selection";
import type { EditorState } from "./state-types";
import { getVisibleTextFromRuns } from "./sync/char-runs";
import { insertCharsAtPosition } from "./sync/crdt-utils";
import { createCRDTbinding } from "./sync/sync";
import { caretStops, layoutMath } from "@cypherkit/tex";
import { parse } from "@cypherkit/tex/internal";
import { describe, expect, it } from "vitest";

/** Block-equation editor state holding `latex`, caret at `caret`. (Same
 * harness as math-command-entry.test.ts.) */
function mathState(latex: string, caret: number) {
  const binding = createCRDTbinding("repro-backslash", "peer-1");
  const engine = createMathTestSyncEngine(binding);
  const blockOp = engine.createBlockInsert(null, "math", { displayMode: true });
  engine.emit([blockOp]);
  let page = engine.getState();
  if (latex) {
    page = insertCharsAtPosition(
      page,
      blockOp.blockId,
      0,
      latex,
      binding,
    ).newPage;
  }
  let state = createMathTestState(page, { crdtBinding: binding });
  state = moveCursorToPosition(state, 0, caret);
  return state;
}

function latexOf(state: EditorState) {
  return getVisibleTextFromRuns(state.document.page.blocks[0].charRuns);
}

/** Type `chars` one keystroke at a time through the real editor pipeline. */
function typeAt(latex: string, caret: number, chars: string): string {
  let state = mathState(latex, caret);
  for (const ch of chars) state = insertText(state, ch).state;
  return latexOf(state);
}

/** User-reachable caret offsets in `latex` (deduped, sorted). */
function stops(latex: string): number[] {
  const layout = layoutMath(latex, { fontSize: 16 });
  return [...new Set(caretStops(layout).map((s) => s.offset))].sort(
    (a, b) => a - b,
  );
}

/** Parse signature: leaf chars (multiset), text contents, structural counts,
 * unknown-command names. */
interface Sig {
  chars: Map<string, number>;
  texts: string[];
  frac: number;
  sqrt: number;
  supsub: number;
  text: number;
  array: number;
  unknowns: string[];
}
function sigOf(latex: string): Sig {
  const sig: Sig = {
    chars: new Map(),
    texts: [],
    frac: 0,
    sqrt: 0,
    supsub: 0,
    text: 0,
    array: 0,
    unknowns: [],
  };
  const walk = (n: unknown): void => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) {
      n.forEach(walk);
      return;
    }
    const node = n as Record<string, unknown>;
    const t = node.type;
    if (t === "atom") {
      const ch = (node.info as { char: string }).char;
      sig.chars.set(ch, (sig.chars.get(ch) ?? 0) + 1);
    } else if (t === "text") {
      sig.texts.push(node.text as string);
      sig.text++;
      // Text content counts per character: inserting a char INSIDE a text run
      // legitimately splits it, so coverage is per-char, not per-substring.
      for (const ch of node.text as string) {
        sig.chars.set(ch, (sig.chars.get(ch) ?? 0) + 1);
      }
    } else if (t === "frac") sig.frac++;
    else if (t === "sqrt") sig.sqrt++;
    else if (t === "supsub") sig.supsub++;
    else if (t === "array") sig.array++;
    else if (t === "unknown") sig.unknowns.push(node.name as string);
    for (const [k, v] of Object.entries(node)) {
      if (k === "span" || k === "info" || k === "charSpans") continue;
      walk(v);
    }
  };
  walk(parse(latex));
  return sig;
}

/** Corruption reasons for `after` relative to `before` (empty = clean).
 * `expectGlyph`: the typed sequence ended in a COMPLETE known command that
 * must typeset (e.g. `\pi` → "π"), and no `unknown` node may remain. */
function corruption(
  before: string,
  after: string,
  expectGlyph: string | null,
): string[] {
  const reasons: string[] = [];
  let b: Sig, a: Sig;
  try {
    b = sigOf(before);
  } catch (e) {
    return [`baseline parse threw: ${String(e)}`];
  }
  try {
    a = sigOf(after);
  } catch (e) {
    return [`result parse threw: ${String(e)}`];
  }
  for (const [ch, n] of b.chars) {
    const have = a.chars.get(ch) ?? 0;
    if (have < n) reasons.push(`lost char '${ch}' (${have}/${n})`);
  }
  for (const k of ["frac", "sqrt", "supsub", "text", "array"] as const) {
    if (a[k] < b[k]) reasons.push(`lost ${k} node (${a[k]}/${b[k]})`);
  }
  if (expectGlyph !== null) {
    if (a.unknowns.length > 0) {
      reasons.push(`unknown command(s) remain: ${a.unknowns.join(", ")}`);
    }
    if ((a.chars.get(expectGlyph) ?? 0) < 1) {
      reasons.push(`typed command never typeset ('${expectGlyph}' missing)`);
    }
  }
  return reasons;
}

const FORMULAS = [
  "\\frac{a}{b}",
  "\\alpha+\\beta",
  "\\sqrt{x}",
  "x^{2}",
  "\\text{hi}",
  "\\begin{matrix}a&b\\\\c&d\\end{matrix}",
];

// Math-mode hosts only. A `\command` typed inside a `\text{…}` run is text mode,
// where it reads as its letters ("pi") rather than typesetting the glyph — that
// is correct LaTeX, not corruption, so it is excluded from the glyph-expecting
// sweep (neighbor preservation there is covered by the MINIMIZED cases below).
const MATH_FORMULAS = FORMULAS.filter((f) => !f.startsWith("\\text{"));

function sweep(
  seq: string,
  expectGlyph: string | null,
  formulas: readonly string[] = FORMULAS,
): string[] {
  const failures: string[] = [];
  for (const f of formulas) {
    for (const at of stops(f)) {
      const out = typeAt(f, at, seq);
      const reasons = corruption(f, out, expectGlyph);
      if (reasons.length > 0) {
        failures.push(
          `"${f}" @${at} (…${f.slice(Math.max(0, at - 3), at)}|${f.slice(at, at + 3)}…) + type ${JSON.stringify(seq)} → "${out}"  [${reasons.join("; ")}]`,
        );
      }
    }
  }
  return failures;
}

describe("SWEEP: stray backslash / slash at every reachable caret stop", () => {
  it("typing the complete command \\pi never corrupts adjacent content", () => {
    const failures = sweep("\\pi", "π", MATH_FORMULAS);
    if (failures.length) console.log(failures.join("\n"));
    expect(failures).toEqual([]);
  });

  it("typing a lone \\ (then abandoning it) never corrupts adjacent content", () => {
    const failures = sweep("\\", null);
    if (failures.length) console.log(failures.join("\n"));
    expect(failures).toEqual([]);
  });

  it("typing a forward slash / never corrupts adjacent content", () => {
    const failures = sweep("/", null);
    if (failures.length) console.log(failures.join("\n"));
    expect(failures).toEqual([]);
  });
});

describe("MINIMIZED reproductions (now fixed: the separator keeps the neighbor)", () => {
  it("x^{2}: \\pi typed before the base letter keeps `x` a separate atom", () => {
    // caret 0 is the formula's leftmost stop — trivially reachable
    expect(typeAt("x^{2}", 0, "\\pi")).toBe("\\pi x^{2}");
    // `x` survives as its own atom; `\pi` typesets; no unknown command
    const sig = sigOf("\\pi x^{2}");
    expect(sig.chars.get("x") ?? 0).toBe(1);
    expect(sig.chars.get("π") ?? 0).toBe(1);
    expect(sig.unknowns).toEqual([]);
  });

  it("\\frac{a}{b}: \\pi typed at the numerator's start keeps `a`", () => {
    expect(typeAt("\\frac{a}{b}", 6, "\\pi")).toBe("\\frac{\\pi a}{b}");
    const sig = sigOf("\\frac{\\pi a}{b}");
    expect(sig.chars.get("a") ?? 0).toBe(1);
    expect(sig.chars.get("π") ?? 0).toBe(1);
    expect(sig.unknowns).toEqual([]);
  });

  it("\\sqrt{x}: \\pi typed at the radicand's start keeps `x`", () => {
    expect(typeAt("\\sqrt{x}", 6, "\\pi")).toBe("\\sqrt{\\pi x}");
  });

  it("\\text{hi}: \\pi typed before `hi` enters as literal text, keeps `hi`", () => {
    // Inside a `\text{}` run the content is prose, not math: a typed `\` is a
    // literal backslash (`\textbackslash{}`), not a command intro, so `\pi`
    // reads as the visible characters "\pi" and `hi` survives verbatim. The old
    // behavior (`\text{\pi hi}`) instead dropped the backslash and typeset "pi
    // hi" — π was never rendered and the keystroke was silently lost.
    expect(typeAt("\\text{hi}", 6, "\\pi")).toBe(
      "\\text{\\textbackslash{}pihi}",
    );
    expect(sigOf("\\text{\\textbackslash{}pihi}").texts).toEqual(["\\pihi"]);
  });

  it("\\text{hi}: \\pi typed MID-text keeps the trailing letter, no data loss", () => {
    expect(typeAt("\\text{hi}", 7, "\\pi")).toBe(
      "\\text{h\\textbackslash{}pii}",
    );
    expect(sigOf("\\text{h\\textbackslash{}pii}").texts).toEqual(["h\\pii"]);
  });

  it("\\text{}: a \\ then letters never swallows a keystroke (the reported bug)", () => {
    // The reported corruption: caret in an empty `\text{}`, type `\hi`. The `\`
    // used to enter a bare `\ ` control space that seeded a fake command run
    // (`\h`), and the next letter was then REJECTED as an unknown command — `\hi`
    // isn't real — so the `i` silently vanished. In text mode `\` is a literal
    // backslash, so every character survives as visible text.
    const typed = typeAt("\\text{}", 6, "\\hi");
    expect(typed).toBe("\\text{\\textbackslash{}hi}");
    expect(sigOf(typed).texts).toEqual(["\\hi"]);
  });

  it("matrix: \\pi typed at a cell's start keeps the cell content", () => {
    const f = "\\begin{matrix}a&b\\\\c&d\\end{matrix}";
    const at = "\\begin{matrix}".length; // before `a`, a real cell-start stop
    expect(typeAt(f, at, "\\pi")).toBe(
      "\\begin{matrix}\\pi a&b\\\\c&d\\end{matrix}",
    );
  });

  it("even a lone abandoned \\ before a letter keeps it a separate atom", () => {
    // The bare `\` gets its protective separator, so `x` is not absorbed.
    expect(typeAt("x^{2}", 0, "\\")).toBe("\\ x^{2}");
    const sig = sigOf("\\ x^{2}");
    expect(sig.chars.get("x") ?? 0).toBe(1); // `x` still an atom
  });
});

describe("CONTRAST: the already-guarded positions stay clean", () => {
  it("\\ before a structural brace gets the separator (fixed path)", () => {
    expect(typeAt("\\frac{a}{b}", 7, "\\")).toBe("\\frac{a\\ }{b}");
  });
  it("\\pi before another command's backslash stays clean (feab125)", () => {
    expect(typeAt("\\alpha+\\beta", 7, "\\pi")).toBe("\\alpha+\\pi\\beta");
  });
  it("\\pi before a DIGIT self-heals (digit terminates the control word)", () => {
    expect(typeAt("x^{2}", 3, "\\pi")).toBe("x^{\\pi2}");
    expect(corruption("x^{2}", "x^{\\pi2}", "π")).toEqual([]);
  });
  it("\\pi before a `+` operator self-heals", () => {
    expect(typeAt("\\alpha+\\beta", 6, "\\pi")).toBe("\\alpha\\pi+\\beta");
  });
});

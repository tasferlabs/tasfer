/**
 * Keystroke fuzzer — the parity harness for the math-editing corruption work.
 *
 * Drives the REAL editor typing/deleting path (insertText → mathTransformTypedInput
 * → separator/heal/materialize; deleteText → mathDeleteUnit) and asserts two
 * complementary guarantees. Together they generalize the corpus tests
 * (math-text-brace-corruption, math-backslash-fusion, math-matrix-cell-
 * integrity), which pin the three REPORTED corruption families to exact outputs:
 *
 * 1. DIRECTED CONSERVATION SWEEP (exhaustive, deterministic). Type ONE
 *    dangerous operation into a CLEAN host at EVERY reachable caret stop and
 *    assert no content is dropped: every leaf char (atom glyphs + text-run
 *    characters) and structural node (frac/sqrt/supsub/text/array/matrix cell)
 *    present in the host survives. This is the anti-corruption gate for RC1
 *    (`\text` swallow), RC2 (backslash fusion), and RC3 (matrix cell loss),
 *    generalized past the corpus fixtures to all hosts × positions × operations.
 *    Starting clean and applying a single operation keeps every probe on the
 *    well-formed manifold, where "typing preserves content" is a real invariant.
 *
 * 2. RANDOM TOTALITY WALK (fuzz). Long random keystroke/delete sequences over
 *    random hosts and caret stops, asserting only that every read path
 *    (parse / layout / caretStops / normalizeLatex) never throws and the caret
 *    never escapes the source — a property that holds for ANY input, however
 *    garbled. Content conservation is NOT asserted here: free-form walks reach
 *    mangled states (via text mode, scripts, escaped braces, deletes) from which
 *    a single keystroke can legally reshuffle the parse, so conservation is only
 *    meaningful from the clean starting points that sweep (1) already covers.
 *
 * KNOWN-REMAINING carve-outs (documented in docs/math-editing-corruption.md):
 * the flat-string model has a residual long tail that only the Phase 2 gate /
 * Phase 4 structured editing fully close. The sweep skips exactly two operations
 * that provably hit that tail — and only those:
 *   A. A plain-letter operation that extends a COMPLETE command into an unknown
 *      one (`\pi` + `t` → `\pit`, because `pit` is a prefix of `\pitchfork`, so
 *      the "still typing a longer command" heuristic suppresses the separator).
 *   B. A superscript/subscript operation (`^`/`_`), which can form an invalid
 *      double script (`x^{2}^{3}`) whose second operand LaTeX itself discards.
 * Each fires only when its exact precondition holds, so a regression of any
 * REPORTED family (all backslash/brace/`&`-driven, from a clean host) is caught.
 *
 * Reproduce a totality failure with FUZZ_SEED=<printed seed>. Scale the walk
 * with FUZZ_RUNS (sequences per seed) and FUZZ_OPS (keystrokes per sequence).
 */
import {
  createMathTestState,
  createMathTestSyncEngine,
} from "./__testutils__/math";
import { deleteText, insertText } from "./actions/actions";
import { moveCursorToPosition } from "./selection";
import type { EditorState } from "./state-types";
import { getVisibleTextFromRuns } from "./sync/char-runs";
import { insertCharsAtPosition } from "./sync/crdt-utils";
import { createCRDTbinding } from "./sync/sync";
import { caretStops, layoutMath, normalizeLatex } from "@cypherkit/tex";
import { parse } from "@cypherkit/tex/internal";
import { describe, expect, it } from "vitest";

// ── Deterministic RNG (mulberry32, same generator as the convergence fuzz) ──

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  constructor(private rnd: () => number) {}
  next(): number {
    return this.rnd();
  }
  int(maxExclusive: number): number {
    return Math.floor(this.rnd() * maxExclusive);
  }
  pick<T>(arr: readonly T[]): T {
    return arr[this.int(arr.length)];
  }
}

// ── Editor harness (same block-equation setup as the corpus tests) ──

function mathState(latex: string, caret: number): EditorState {
  const binding = createCRDTbinding("fuzz-keystroke", "peer-1");
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

function latexOf(state: EditorState): string {
  return getVisibleTextFromRuns(state.document.page.blocks[0].charRuns);
}

function caretOf(state: EditorState): number {
  return state.document.cursor?.position.textIndex ?? 0;
}

/** User-reachable caret offsets in `latex` (deduped, sorted). */
function stops(latex: string): number[] {
  if (!latex) return [0];
  const layout = layoutMath(latex, { fontSize: 16 });
  return [...new Set(caretStops(layout).map((s) => s.offset))].sort(
    (a, b) => a - b,
  );
}

// ── Structural signature used by the conservation oracles ──

interface Sig {
  chars: Map<string, number>;
  frac: number;
  sqrt: number;
  supsub: number;
  text: number;
  array: number;
  /** Aggregate matrix geometry across every array node in the tree. maxCols is
   * deliberately NOT tracked: it isn't monotonic under insertion (a `\\` mid-row
   * splits a row into two narrower ones), so only rows/cells are conserved. */
  rows: number;
  cells: number;
}

function bump(m: Map<string, number>, k: string): void {
  // Exclude delimiter-ambiguous characters from the conservation multiset:
  //  - whitespace is a separator the editor legitimately inserts and drops
  //    (protective command separators, redundant-space cleanup);
  //  - `[` / `]` flip between literal glyphs and structure (a `\sqrt[…]` optional
  //    index, `\left[`), so their atom count isn't a reliable content signal.
  // Real content stays covered: characters INSIDE the brackets are still counted.
  if (/[\s[\]]/.test(k)) return;
  m.set(k, (m.get(k) ?? 0) + 1);
}

function sigOf(latex: string): Sig {
  const sig: Sig = {
    chars: new Map(),
    frac: 0,
    sqrt: 0,
    supsub: 0,
    text: 0,
    array: 0,
    rows: 0,
    cells: 0,
  };
  const walk = (n: unknown): void => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) {
      n.forEach(walk);
      return;
    }
    const node = n as Record<string, unknown>;
    switch (node.type) {
      case "atom":
        bump(sig.chars, (node.info as { char: string }).char);
        break;
      case "text":
        sig.text++;
        // A char inserted INSIDE a text run legitimately splits it, so coverage
        // is per-character (multiset), not per-substring.
        for (const ch of node.text as string) bump(sig.chars, ch);
        break;
      case "frac":
        sig.frac++;
        break;
      case "sqrt":
        sig.sqrt++;
        break;
      case "supsub":
        sig.supsub++;
        break;
      case "array": {
        sig.array++;
        const grid = node.rows as unknown[][];
        sig.rows += grid.length;
        for (const row of grid) sig.cells += row.length;
        break;
      }
    }
    for (const [k, v] of Object.entries(node)) {
      if (k === "span" || k === "info" || k === "charSpans") continue;
      walk(v);
    }
  };
  walk(parse(latex));
  return sig;
}

/** Whether the tree contains an `unknown` command node. */
function hasUnknownCommand(latex: string): boolean {
  let found = false;
  const walk = (n: unknown): void => {
    if (found || !n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach(walk);
    const node = n as Record<string, unknown>;
    if (node.type === "unknown") {
      found = true;
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      if (k === "span" || k === "info" || k === "charSpans") continue;
      walk(v);
    }
  };
  walk(parse(latex));
  return found;
}

// ── Oracles. Each returns a corruption reason, or "" when clean. ──

/** O1: the source must survive every read path the renderer/editor runs. */
function checkTotality(latex: string): string {
  try {
    parse(latex);
    const layout = layoutMath(latex, { fontSize: 16 });
    caretStops(layout);
    normalizeLatex(latex);
  } catch (e) {
    return `read path threw: ${String(e)}`;
  }
  return "";
}

/** O2 + O3: no surviving content vanished between two consecutive states. */
function checkConservation(before: Sig, after: Sig): string {
  const reasons: string[] = [];
  for (const [ch, n] of before.chars) {
    const have = after.chars.get(ch) ?? 0;
    if (have < n) reasons.push(`lost char '${ch}' (${have}/${n})`);
  }
  for (const k of ["frac", "sqrt", "supsub", "text", "array"] as const) {
    if (after[k] < before[k]) {
      reasons.push(`lost ${k} node (${after[k]}/${before[k]})`);
    }
  }
  // Total cells and row count are monotonic under insertion: typing `&` adds a
  // cell, `\\` adds a row. (maxCols is not — see the Sig definition.)
  for (const k of ["rows", "cells"] as const) {
    if (after[k] < before[k]) {
      reasons.push(`matrix ${k} shrank (${after[k]}/${before[k]})`);
    }
  }
  return reasons.join("; ");
}

/**
 * Carve-out A — the inserted letters extend a COMPLETE command into an unknown
 * one, so the command's glyph is lost to the flat-string command-boundary
 * ambiguity (see the file header). Precise: fires only when a backslash-free
 * letter run, typed right after a `\`+letters control word, turns a
 * currently-known command into an unknown one. Backslash-led input (every
 * reported fusion family) never matches.
 */
function isCommandAppend(
  before: string,
  caret: number,
  inserted: string,
): boolean {
  if (!/^[a-zA-Z]+$/.test(inserted)) return false; // letters only, no `\`
  let i = caret;
  while (i > 0 && /[a-zA-Z]/.test(before[i - 1])) i--;
  // The letters form a command only if preceded by an ODD number of backslashes
  // (the innermost `\` escapes them). An even count means a line-break `\\`
  // whose trailing letters are ordinary atoms — including the `\\\alpha` case
  // inside a matrix (row break + command).
  let b = i;
  while (b > 0 && before[b - 1] === "\\") b--;
  if ((i - b) % 2 === 0) return false;
  const cmd = "\\" + before.slice(i, caret); // "\pi"
  return !hasUnknownCommand(cmd) && hasUnknownCommand(cmd + inserted);
}

/** Carve-out B — a script keystroke, which can form an invalid double script. */
function isScriptInput(inserted: string): boolean {
  return inserted.includes("^") || inserted.includes("_");
}

// ── Workload ──

const HOSTS: readonly string[] = [
  "",
  "x+y",
  "ab+cd",
  "\\frac{a}{b}",
  "\\frac{}{b}",
  "\\sqrt{x}",
  "x^{2}",
  "x_{i}",
  "x^{2}_{i}",
  "\\alpha+\\beta",
  "\\pi",
  "\\text{hi}",
  "\\textrm{ab}",
  "\\frac{\\alpha}{\\sqrt{x}}",
  "\\sum_{i=0}^{n}",
  "\\begin{matrix}a&b\\end{matrix}",
  "\\begin{matrix}a&b\\\\c&d\\end{matrix}",
];

// Single-char keystrokes, biased toward the structurally dangerous characters
// (backslash, slash, braces, brackets, matrix separators, scripts) that drove
// every reported corruption; ordinary letters/digits/operators fill the rest.
const KEYS: readonly string[] = [
  ..."\\\\\\\\", // backslash, over-weighted
  ..."////",
  ..."{{}}",
  ..."[[]]",
  ..."&&", // matrix column separator
  ..."^_",
  ..."$",
  ..."abcxyztih",
  ..."012",
  ..."+-=. ",
];

// Multi-char bursts typed one keystroke at a time — the way a real user forms a
// command. These reach the known-command self-heal and auto-close paths that a
// purely random single-char stream would hit only rarely.
const BURSTS: readonly string[] = [
  "\\pi",
  "\\alpha",
  "\\beta",
  "\\frac",
  "\\sqrt",
  "\\text{",
  "\\text{hi}",
  "\\\\",
  "&",
  "[a]",
  "^{2}",
  "_{i}",
];

interface Action {
  kind: "key" | "burst" | "delete" | "move";
  data?: string;
  to?: number;
}

function describeScript(host: string, caret: number, log: Action[]): string {
  const parts = log.map((a) => {
    if (a.kind === "move") return `move→${a.to}`;
    if (a.kind === "delete") return "⌫";
    return JSON.stringify(a.data);
  });
  return `host=${JSON.stringify(host)} caret=${caret}\n  ${parts.join(" ")}`;
}

interface Failure {
  reason: string;
  step: number;
  source: string;
  script: string;
}

/**
 * Run one random keystroke sequence and enforce O1 (totality) + caret sanity
 * after every keystroke. `allowDelete` mixes in backspaces.
 *
 * Content CONSERVATION is deliberately NOT asserted here. Free-form walks —
 * through text mode, scripts, escaped braces, deletes — reach mangled states
 * from which a single keystroke can legally reshuffle the parse; "one keystroke
 * preserves content" is only a meaningful invariant from a CLEAN formula, which
 * the directed conservation sweep below covers exhaustively. What DOES hold for
 * any input, however garbled, is that the read paths never crash and the caret
 * never escapes the source — the robustness guarantee this walk stresses.
 */
function runSequence(
  rng: Rng,
  ops: number,
  allowDelete: boolean,
): Failure | null {
  const host = rng.pick(HOSTS);
  const startCaret = rng.pick(stops(host));

  let state = mathState(host, startCaret);
  let prevSrc = latexOf(state);
  const log: Action[] = [];

  const fail = (reason: string, step: number): Failure => ({
    reason,
    step,
    source: latexOf(state),
    script: describeScript(host, startCaret, log),
  });

  for (let step = 0; step < ops; step++) {
    // Occasionally hop to a different reachable caret stop to explore positions
    // the natural post-edit caret wouldn't reach.
    if (rng.next() < 0.35) {
      const to = rng.pick(stops(prevSrc));
      log.push({ kind: "move", to });
      state = moveCursorToPosition(state, 0, to);
    }

    const roll = rng.next();
    try {
      if (allowDelete && roll < 0.2) {
        log.push({ kind: "delete" });
        state = deleteText(state).state;
      } else if (roll < 0.5) {
        const burst = rng.pick(BURSTS);
        log.push({ kind: "burst", data: burst });
        for (const ch of burst) state = insertText(state, ch).state;
      } else {
        const key = rng.pick(KEYS);
        log.push({ kind: "key", data: key });
        state = insertText(state, key).state;
      }
    } catch (e) {
      return fail(`editor threw during input: ${String(e)}`, step);
    }

    const src = latexOf(state);
    const totality = checkTotality(src);
    if (totality) return fail(totality, step);
    const c = caretOf(state);
    if (c < 0 || c > src.length) {
      return fail(`caret ${c} out of range [0,${src.length}]`, step);
    }
    prevSrc = src;
  }
  return null;
}

function runFuzz(
  seed: number,
  runs: number,
  ops: number,
  allowDelete: boolean,
): Failure | null {
  const rng = new Rng(mulberry32(seed));
  for (let r = 0; r < runs; r++) {
    const failure = runSequence(rng, ops, allowDelete);
    if (failure) return failure;
  }
  return null;
}

// ── Directed conservation sweep ──
//
// The exhaustive complement to the random walk: type ONE dangerous operation
// into a CLEAN host at EVERY reachable caret stop and assert no content is
// dropped. Because each probe starts clean and applies a single operation, it
// stays on the well-formed manifold where "typing preserves content" is a real
// invariant — directly generalizing the corpus's fixed-family cases (RC1 `\text`
// swallow, RC2 backslash fusion, RC3 matrix cell loss) to all hosts/positions.

const OPERATIONS: readonly string[] = [
  "\\",
  "/",
  "\\pi",
  "\\alpha",
  "\\frac",
  "\\sqrt",
  "\\text{hi}",
  "&",
  "\\\\",
  "+",
  "a",
  "1",
  "{",
  "}",
];

interface Probe {
  host: string;
  stop: number;
  op: string;
  result: string;
  reason: string;
}

function typeOp(host: string, stop: number, op: string): string {
  let state = mathState(host, stop);
  for (const ch of op) state = insertText(state, ch).state;
  return latexOf(state);
}

function sweepConservation(): Probe[] {
  const failures: Probe[] = [];
  for (const host of HOSTS) {
    const hostSig = sigOf(host);
    for (const stop of stops(host)) {
      for (const op of OPERATIONS) {
        // Carve-out A (letter appended to a complete command) and B (a script)
        // are the documented flat-string long tail — see the file header.
        if (isScriptInput(op)) continue;
        if (isCommandAppend(host, stop, op)) continue;
        const result = typeOp(host, stop, op);
        const reason = checkConservation(hostSig, sigOf(result));
        if (reason) failures.push({ host, stop, op, result, reason });
      }
    }
  }
  return failures;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function report(seed: number, f: Failure | null): string | undefined {
  if (!f) return undefined;
  return [
    `seed=${seed} (re-run with FUZZ_SEED=${seed})`,
    `step ${f.step}: ${f.reason}`,
    `source: ${JSON.stringify(f.source)}`,
    `script: ${f.script}`,
  ].join("\n");
}

// Deterministic seeds keep CI stable; the random seed below is reproducible
// via FUZZ_SEED=<printed seed>.
const FIXED_SEEDS = [1, 7, 12345, 67890, 424242];

describe("math keystroke fuzz", () => {
  // Exhaustive, deterministic: no content is dropped by a single operation typed
  // into any clean host at any caret stop. This is the anti-corruption gate for
  // the reported families (RC1/RC2/RC3), generalized past the corpus's fixtures.
  it("directed conservation sweep (host × stop × operation)", () => {
    const failures = sweepConservation();
    if (failures.length) {
      console.log(
        failures
          .slice(0, 20)
          .map(
            (p) =>
              `${JSON.stringify(p.host)} @${p.stop} + ${JSON.stringify(p.op)} → ${JSON.stringify(p.result)}  [${p.reason}]`,
          )
          .join("\n"),
      );
    }
    expect(failures).toEqual([]);
  });

  // Robustness: random walks that stress the parse/layout/caret/normalize read
  // paths. No content conservation is asserted (see runSequence) — only that no
  // keystroke sequence EVER throws or produces an out-of-range caret.
  describe("totality (never crashes, caret always in range)", () => {
    const runs = envInt("FUZZ_RUNS", 150);
    const ops = envInt("FUZZ_OPS", 60);
    for (const allowDelete of [false, true]) {
      const mode = allowDelete ? "insert+delete" : "insert-only";
      for (const seed of FIXED_SEEDS) {
        it(`${mode} stays total (seed=${seed}, runs=${runs}, ops=${ops})`, () => {
          const f = runFuzz(seed, runs, ops, allowDelete);
          expect(f, report(seed, f)).toBeNull();
        });
      }
      it(`${mode} stays total (random or FUZZ_SEED seed)`, () => {
        const seed = envInt("FUZZ_SEED", Math.floor(Math.random() * 1e9));
        console.log(`${mode} fuzz seed=${seed}`);
        const f = runFuzz(seed, runs, ops, allowDelete);
        expect(f, report(seed, f)).toBeNull();
      });
    }
  });
});

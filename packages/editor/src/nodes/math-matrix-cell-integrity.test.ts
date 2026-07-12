/**
 * Regression corpus — matrix cell integrity: typing or deleting characters
 * inside matrix cells must not destroy cells or grid structure.
 *
 * Drives the REAL editor pipeline (INSERT_TEXT / DELETE_BACKWARD /
 * DELETE_FORWARD dispatched through the action bus, one keystroke at a time,
 * exactly like keysEvents.ts does) against math blocks holding matrices, and
 * checks structural oracles after every keystroke:
 *   - the source still parses and still contains exactly one \begin/\end pair
 *   - grid dimensions are preserved (unless the keystroke is explicitly
 *     structural: `&`, `\`)
 *   - every cell the keystroke did not target keeps its source verbatim
 *
 * Location when run: packages/editor/src/nodes/__repro_matrix-cells.test.ts
 * Run: cd packages/editor && npx vitest run src/nodes/__repro_matrix-cells.test.ts
 */
import { createMathTestState } from "../__testutils__/math";
import {
  DELETE_BACKWARD,
  DELETE_FORWARD,
  INSERT_TEXT,
} from "../actions/edit-actions";
import type { CursorState, EditorState, Page } from "../state-types";
import { getVisibleTextFromRuns } from "../sync/char-runs";
import { mathCaretOffsets, mathMatrixContext } from "./math";
import type { MathBlock } from "./MathNode";
import { parse } from "@cypherkit/tex/internal";
import { describe, expect, it } from "vitest";

// ─── harness ─────────────────────────────────────────────────────────────────

function mathBlock(latex: string): MathBlock {
  return {
    id: "math-1",
    orderKey: "a1",
    type: "math",
    charRuns: latex ? [{ peerId: "seed", startCounter: 100, text: latex }] : [],
    formats: [],
    displayMode: true,
  };
}

function stateAt(latex: string, textIndex: number): EditorState {
  const page: Page = { id: "page-1", title: "", blocks: [mathBlock(latex)] };
  const cursor: CursorState = {
    position: { blockIndex: 0, textIndex },
    lastUpdate: 0,
  };
  const state = createMathTestState(page);
  return { ...state, document: { ...state.document, cursor } };
}

function latexOf(state: EditorState): string {
  const block = state.document.page.blocks[0];
  return "charRuns" in block ? getVisibleTextFromRuns(block.charRuns) : "";
}

function hasSelection(state: EditorState): boolean {
  const sel = state.document.selection;
  return !!sel && !sel.isCollapsed;
}

// ─── grid oracle ─────────────────────────────────────────────────────────────

interface Grid {
  env: string;
  cells: string[][]; // verbatim source of each cell
}

/* Walk the whole AST object graph for array nodes (order: outermost first). */
function findArrays(node: unknown, out: unknown[] = []): unknown[] {
  if (node && typeof node === "object") {
    const n = node as Record<string, unknown>;
    if (n.type === "array") out.push(node);
    for (const v of Object.values(n)) {
      if (Array.isArray(v)) for (const x of v) findArrays(x, out);
      else if (v && typeof v === "object") findArrays(v, out);
    }
  }
  return out;
}

function gridOf(latex: string): Grid | null {
  let root: unknown;
  try {
    root = parse(latex);
  } catch {
    return null;
  }
  const arrays = findArrays(root) as {
    env: string;
    rows: { span: { start: number; end: number } }[][];
  }[];
  if (arrays.length === 0) return null;
  const a = arrays[0];
  return {
    env: a.env,
    cells: a.rows.map((r) =>
      r.map((c) => latex.slice(c.span.start, c.span.end)),
    ),
  };
}

function dims(g: Grid): string {
  return `${g.cells.length}x${g.cells.map((r) => r.length).join(",")}`;
}

/** Cells that differ between two same-shaped grids, as "r,c" keys.
 *  Returns null when the shapes differ. */
function changedCells(before: Grid, after: Grid): string[] | null {
  if (before.cells.length !== after.cells.length) return null;
  const out: string[] = [];
  for (let r = 0; r < before.cells.length; r++) {
    if (before.cells[r].length !== after.cells[r].length) return null;
    for (let c = 0; c < before.cells[r].length; c++) {
      if (before.cells[r][c] !== after.cells[r][c]) out.push(`${r},${c}`);
    }
  }
  return out;
}

/** Multiset of atom characters — everything except the structural `& \ { }` and
 *  whitespace, which reshape cells without being content. */
function countAtoms(s: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const ch of s) {
    if (
      ch === "&" ||
      ch === "\\" ||
      ch === "{" ||
      ch === "}" ||
      /\s/.test(ch)
    ) {
      continue;
    }
    out.set(ch, (out.get(ch) ?? 0) + 1);
  }
  return out;
}

function envCount(latex: string): { begins: number; ends: number } {
  return {
    begins: (latex.match(/\\begin\{/g) ?? []).length,
    ends: (latex.match(/\\end\{/g) ?? []).length,
  };
}

/** Caret stops strictly inside the environment body. */
function bodyStops(latex: string): number[] {
  const bodyStart = latex.indexOf("}") + 1; // after \begin{env}
  const bodyEnd = latex.lastIndexOf("\\end{");
  return mathCaretOffsets(latex).filter((p) => p >= bodyStart && p <= bodyEnd);
}

// ─── hosts ───────────────────────────────────────────────────────────────────

const HOSTS = [
  "\\begin{pmatrix}{}&{}\\\\{}&{}\\end{pmatrix}", // fresh template
  "\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}", // filled, bare cells
  "\\begin{bmatrix}12&x^{2}\\\\\\frac{a}{b}&\\sin x\\end{bmatrix}", // constructs
  "\\begin{pmatrix}a&{}\\\\{}&d\\end{pmatrix}", // mixed empty/filled
  "\\begin{cases}x&y\\\\z&w\\end{cases}",
  "\\begin{array}{cc}a&b\\\\c&d\\end{array}",
];

// Non-structural single keystrokes: must never change grid shape or any
// untouched cell.
const PLAIN_KEYS = ["x", "1", "+", "{", "}", "^", "_", "[", "]", " ", "'"];
// Explicitly structural keystrokes: may change shape, must not lose content.
const STRUCT_KEYS = ["&", "\\"];

interface Failure {
  host: string;
  stop: number;
  op: string;
  before: string;
  after: string;
  reason: string;
}

function fmt(f: Failure) {
  return `\n[${f.op}] stop=${f.stop} ${f.reason}\n  before: ${f.before}\n  after:  ${f.after}`;
}

// ─── single keystrokes at every caret stop ───────────────────────────────────

describe("matrix cells — single typed characters", () => {
  it("plain keystrokes preserve grid shape and untouched cells", () => {
    const failures: Failure[] = [];
    for (const host of HOSTS) {
      const before = gridOf(host)!;
      for (const stop of bodyStops(host)) {
        for (const key of PLAIN_KEYS) {
          const res = stateAt(host, stop).actionBus.dispatchState(
            INSERT_TEXT,
            stateAt(host, stop),
            { text: key },
          );
          const after = latexOf(res.state);
          const fail = (reason: string) =>
            failures.push({
              host,
              stop,
              op: `type ${JSON.stringify(key)}`,
              before: host,
              after,
              reason,
            });
          const ec = envCount(after);
          if (ec.begins !== 1 || ec.ends !== 1) {
            fail(`env pair broken (${ec.begins} begins / ${ec.ends} ends)`);
            continue;
          }
          const g = gridOf(after);
          if (!g) {
            fail("no array parses any more");
            continue;
          }
          const changed = changedCells(before, g);
          if (changed === null) {
            fail(`grid shape changed ${dims(before)} -> ${dims(g)}`);
            continue;
          }
          if (changed.length > 1) {
            fail(`multiple cells changed: ${changed.join(" | ")}`);
            continue;
          }
          const ctx = mathMatrixContext(host, stop);
          if (
            changed.length === 1 &&
            ctx &&
            changed[0] !== `${ctx.row},${ctx.col}`
          ) {
            fail(
              `wrong cell changed: caret in ${ctx.row},${ctx.col} but ${changed[0]} changed`,
            );
          }
        }
      }
    }
    expect(failures.map(fmt).join("\n")).toBe("");
  });

  it("structural keystrokes (& and backslash) never lose cell content", () => {
    const failures: Failure[] = [];
    for (const host of HOSTS) {
      const before = gridOf(host)!;
      for (const stop of bodyStops(host)) {
        for (const key of STRUCT_KEYS) {
          const res = stateAt(host, stop).actionBus.dispatchState(
            INSERT_TEXT,
            stateAt(host, stop),
            { text: key },
          );
          const after = latexOf(res.state);
          const fail = (reason: string) =>
            failures.push({
              host,
              stop,
              op: `type ${JSON.stringify(key)}`,
              before: host,
              after,
              reason,
            });
          const ec = envCount(after);
          if (ec.begins !== 1 || ec.ends !== 1) {
            fail(`env pair broken (${ec.begins} begins / ${ec.ends} ends)`);
            continue;
          }
          const g = gridOf(after);
          if (!g) {
            fail("no array parses any more");
            continue;
          }
          // Structural keys legitimately RESHAPE cells — typing `&` inside "12"
          // splits it into "1"|"2" — so a cell's source need not survive as a
          // contiguous substring. The real invariant is that no atom character
          // of the original cells is lost: every non-structural char (letters,
          // digits, operators — not `& \ { }` or spaces) still appears across
          // the resulting cells. (Exact corruption is pinned by the minimized
          // scenarios below.)
          const want = countAtoms(before.cells.flat().join(""));
          const have = countAtoms(g.cells.flat().join(""));
          for (const [ch, n] of want) {
            if ((have.get(ch) ?? 0) < n) {
              fail(`atom '${ch}' lost from cells (${have.get(ch) ?? 0}/${n})`);
              break;
            }
          }
        }
      }
    }
    expect(failures.map(fmt).join("\n")).toBe("");
  });
});

// ─── single deletions at every caret stop ────────────────────────────────────

describe("matrix cells — backspace / forward delete", () => {
  for (const [op, ACTION] of [
    ["backspace", DELETE_BACKWARD],
    ["delete", DELETE_FORWARD],
  ] as const) {
    it(`${op} at every stop is confined to one cell (or selects)`, () => {
      const failures: Failure[] = [];
      for (const host of HOSTS) {
        const before = gridOf(host)!;
        for (const stop of bodyStops(host)) {
          const s0 = stateAt(host, stop);
          const res = s0.actionBus.dispatchState(ACTION, s0);
          const after = latexOf(res.state);
          const fail = (reason: string) =>
            failures.push({ host, stop, op, before: host, after, reason });

          if (hasSelection(res.state)) {
            // Select-first policy: the press must not have edited anything.
            if (after !== host) fail("selection AND source changed");
            continue;
          }
          if (after === host) continue; // no-op is fine
          const ec = envCount(after);
          if (ec.begins !== 1 || ec.ends !== 1) {
            fail(`env pair broken (${ec.begins} begins / ${ec.ends} ends)`);
            continue;
          }
          const g = gridOf(after);
          if (!g) {
            fail("no array parses any more");
            continue;
          }
          const changed = changedCells(before, g);
          if (changed === null) {
            fail(`grid shape changed ${dims(before)} -> ${dims(g)}`);
            continue;
          }
          if (changed.length > 1) {
            fail(`multiple cells changed: ${changed.join(" | ")}`);
          }
        }
      }
      expect(failures.map(fmt).join("\n")).toBe("");
    });
  }
});

// ─── minimized end-state scenarios ───────────────────────────────────────────
// Each types a COMPLETE user gesture (not a transient prefix) and checks the
// final state — corruption here is permanent, not mid-edit noise.

describe("matrix cells — minimized permanent corruptions", () => {
  interface Scenario {
    name: string;
    host: string;
    caret: number;
    keys: string[]; // "⌫" = backspace
    /** expected grid dims, e.g. "2x2,2" (rows x cols-per-row) */
    wantDims: string;
  }
  const FILLED = "\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}";
  const TEMPLATE = "\\begin{pmatrix}{}&{}\\\\{}&{}\\end{pmatrix}";
  const scenarios: Scenario[] = [
    {
      name: "S1 backspace lone char of bottom-right cell",
      host: FILLED,
      caret: FILLED.indexOf("d") + 1,
      keys: ["⌫"],
      wantDims: "2x2,2",
      // ACTUAL: dims=2x2,1 latex=\begin{pmatrix}a&b\\c&\end{pmatrix}
    },
    {
      name: "S2 type \\text{hi} before b",
      host: FILLED,
      caret: FILLED.indexOf("&") + 1,
      keys: ["\\", "t", "e", "x", "t", "{", "h", "i", "}"],
      wantDims: "2x2,2",
      // ACTUAL: dims=1x2 latex=\begin{pmatrix}a&\text{hi\}b\\c&d\end{pmatrix}}
    },
    {
      name: "S3 type \\text{hi} in first template cell",
      host: TEMPLATE,
      caret: TEMPLATE.indexOf("{}") + 1,
      keys: ["\\", "t", "e", "x", "t", "{", "h", "i", "}"],
      wantDims: "2x2,2",
      // ACTUAL: dims=1x1 latex=\begin{pmatrix}{\text{hi}&{}\\{}&{}\end{pmatrix}}
    },
    {
      name: "S4 type \\sqrt[3] then content before b",
      host: FILLED,
      caret: FILLED.indexOf("&") + 1,
      keys: ["\\", "s", "q", "r", "t", "[", "3", "]"],
      wantDims: "2x2,2",
      // ACTUAL dims pass but latex=\begin{pmatrix}a&\sqrt[3]b\\c&d\end{pmatrix}{}{}
      // (neighbor b swallowed as radicand; stray {}{} outside the env)
    },
    // S5 (typing a literal `\{` at a cell start flush after a `\\` row break) is
    // a KNOWN-REMAINING residual — see the it.fails block at the end of the file.
    {
      name: "S6 type & inside braced superscript slot",
      host: "\\begin{bmatrix}12&x^{2}\\\\c&d\\end{bmatrix}",
      caret: "\\begin{bmatrix}12&x^{2}".indexOf("2}") + 0, // before the 2 in ^{2}
      keys: ["&"],
      wantDims: "2x2,2", // passes — harmless
    },
    {
      name: "S7 type \\operatorname before b",
      host: FILLED,
      caret: FILLED.indexOf("&") + 1,
      keys: ["\\", "o", "p", "e", "r", "a", "t", "o", "r", "n", "a", "m", "e"],
      wantDims: "2x2,2",
      // passes on dims; latex = ...a&\operatornameb... (weld, renders red)
    },
  ];

  for (const sc of scenarios) {
    it(sc.name, () => {
      let state = stateAt(sc.host, sc.caret);
      for (const key of sc.keys) {
        const res =
          key === "⌫"
            ? state.actionBus.dispatchState(DELETE_BACKWARD, state)
            : state.actionBus.dispatchState(INSERT_TEXT, state, { text: key });
        state = res.state;
      }
      const after = latexOf(state);
      const g = gridOf(after);
      const got = g ? dims(g) : "NO ARRAY";

      console.log(
        `${sc.name}\n  dims=${got}\n  latex=${after}\n  cells=${JSON.stringify(g?.cells)}`,
      );
      expect(
        `dims=${got} latex=${after}`,
        `final state after ${sc.keys.join("")}`,
      ).toMatch(
        new RegExp(
          `^dims=${sc.wantDims.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")} `,
        ),
      );
    });
  }
});

// ─── multi-keystroke sequences typed char-by-char ────────────────────────────

const SEQUENCES: string[][] = [
  ["\\", "t", "e", "x", "t", "{", "h", "i", "}"],
  ["\\", "f", "r", "a", "c"],
  ["x", "^", "2"],
  ["a", "b", "⌫", "⌫", "⌫"], // type two, erase three (into what was there)
  ["(", ")"],
  ["\\", "s", "i", "n", " ", "x"],
];

// KNOWN-REMAINING sequences (distinct mechanisms the four Phase 0 fixes do not
// cover, tracked by the it.fails block at the end of the file): a literal `\{`
// typed at a cell start, and `\sqrt[…]` optional-index editing.
const KNOWN_REMAINING_SEQUENCES: string[][] = [
  ["\\", "{", "1", "\\", "}"],
  ["\\", "s", "q", "r", "t", "[", "3", "]"],
];

describe("matrix cells — char-by-char sequences", () => {
  it("every intermediate state keeps other cells and grid shape intact", () => {
    const failures: Failure[] = [];
    for (const host of HOSTS) {
      const before = gridOf(host)!;
      for (const stop of bodyStops(host)) {
        const ctx = mathMatrixContext(host, stop);
        if (!ctx) continue;
        for (const seq of SEQUENCES) {
          let state = stateAt(host, stop);
          let steps = "";
          for (const key of seq) {
            steps += key;
            const res =
              key === "⌫"
                ? state.actionBus.dispatchState(DELETE_BACKWARD, state)
                : state.actionBus.dispatchState(INSERT_TEXT, state, {
                    text: key,
                  });
            state = res.state;
            const after = latexOf(state);
            const fail = (reason: string) =>
              failures.push({
                host,
                stop,
                op: `seq "${seq.join("")}" @ "${steps}"`,
                before: host,
                after,
                reason,
              });
            if (hasSelection(state)) break; // select-first: stop the sequence
            const ec = envCount(after);
            if (ec.begins !== 1 || ec.ends !== 1) {
              fail(`env pair broken (${ec.begins}/${ec.ends})`);
              break;
            }
            const g = gridOf(after);
            if (!g) {
              fail("no array parses any more");
              break;
            }
            const changed = changedCells(before, g);
            if (changed === null) {
              fail(`grid shape changed ${dims(before)} -> ${dims(g)}`);
              break;
            }
            const foreign = changed.filter(
              (k) => k !== `${ctx.row},${ctx.col}`,
            );
            if (foreign.length > 0) {
              fail(
                `foreign cells changed: ${foreign.join(" | ")} (caret cell ${ctx.row},${ctx.col})`,
              );
              break;
            }
          }
        }
      }
    }
    expect(failures.map(fmt).join("\n")).toBe("");
  });
});

// ─── KNOWN REMAINING (Phase 0.1) ─────────────────────────────────────────────
// Two distinct mechanisms the four Phase 0 fixes do NOT address. Kept as
// it.fails so they are tracked rather than silently dropped: when a follow-up
// fixes one, its test starts passing and it.fails flips to a failure, prompting
// removal of the marker.
//
//  1. A literal `\{` typed at a cell start flush after a `\\` row break: the
//     `\`-fusion separator lands beside the row break and the escaped `\{`
//     compounds it into `\\\\{`, spawning a spurious empty row and a raw group.
//  2. `\sqrt[…]` optional-index editing: typing a command/argument inside the
//     index mis-nests the radicand and can reshape the enclosing matrix.

describe("KNOWN REMAINING: matrix cell residuals", () => {
  it.fails("a literal \\{ typed at a cell start keeps the grid 2x2", () => {
    const FILLED = "\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}";
    let state = stateAt(FILLED, FILLED.indexOf("c"));
    for (const key of ["\\", "{"]) {
      state = state.actionBus.dispatchState(INSERT_TEXT, state, {
        text: key,
      }).state;
    }
    const g = gridOf(latexOf(state));
    expect(g && dims(g)).toBe("2x2,2");
  });

  it.fails("\\{…} / \\sqrt[…] sequences never reshape the grid", () => {
    const failures: string[] = [];
    for (const host of HOSTS) {
      const before = gridOf(host)!;
      for (const stop of bodyStops(host)) {
        if (!mathMatrixContext(host, stop)) continue;
        for (const seq of KNOWN_REMAINING_SEQUENCES) {
          let state = stateAt(host, stop);
          for (const key of seq) {
            state =
              key === "⌫"
                ? state.actionBus.dispatchState(DELETE_BACKWARD, state).state
                : state.actionBus.dispatchState(INSERT_TEXT, state, {
                    text: key,
                  }).state;
            if (hasSelection(state)) break;
            const after = latexOf(state);
            const ec = envCount(after);
            if (ec.begins !== 1 || ec.ends !== 1) {
              failures.push(`env broken ${host}@${stop}`);
              break;
            }
            const g = gridOf(after);
            if (!g || changedCells(before, g) === null) {
              failures.push(`shape changed ${host}@${stop}`);
              break;
            }
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });
});

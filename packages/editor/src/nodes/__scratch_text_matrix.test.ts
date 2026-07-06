import { INSERT_TEXT, DELETE_BACKWARD } from "../actions/edit-actions";
import type { CursorState, EditorState, Page } from "../state-types";
import { createInitialState } from "../state-utils";
import { getVisibleTextFromRuns } from "../sync/char-runs";
import type { MathBlock } from "./MathNode";
import { parse } from "@cypherkit/tex/internal";
import { mathCaretOffsets, mathMatrixContext } from "./math";
import { describe, it, expect } from "vitest";

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
  const state = createInitialState(page);
  return { ...state, document: { ...state.document, cursor } };
}
function latexOf(state: EditorState): string {
  const block = state.document.page.blocks[0];
  return "charRuns" in block ? getVisibleTextFromRuns(block.charRuns) : "";
}
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
function dims(latex: string): string | null {
  let root: unknown;
  try { root = parse(latex); } catch { return "PARSE_ERR"; }
  const arrays = findArrays(root) as { rows: unknown[][] }[];
  if (!arrays.length) return "NO_ARRAY";
  const a = arrays[0];
  return `${a.rows.length}x${a.rows.map((r) => r.length).join(",")}`;
}

const HOSTS = [
  "\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}",
  "\\begin{bmatrix}12&x^{2}\\\\\\frac{a}{b}&\\sin x\\end{bmatrix}",
  "\\begin{cases}x&y\\\\z&w\\end{cases}",
  "\\begin{array}{cc}a&b\\\\c&d\\end{array}",
  "\\begin{pmatrix}{}&{}\\\\{}&{}\\end{pmatrix}",
];

// Various \text-ish sequences a user might type
const SEQS: string[][] = [
  ["\\","t","e","x","t","{"],
  ["\\","t","e","x","t","{","h","i"],
  ["\\","t","e","x","t","{","h","i","}"],
  ["\\","t","e","x","t"],                 // no brace yet
  ["\\","t","e","x","t"," "],             // command then space
  ["\\","t","e","x","t","{"," "],         // \text{ then space
  ["\\","t","e","x","t","{","a"," ","b"], // \text{a b
  ["\\","t","e","x","t","r","m","{"],     // \textrm{
  ["\\","m","a","t","h","r","m","{","x"], // \mathrm{x
  ["\\","t","e","x","t","{","a","}","b"], // \text{a}b
  ["\\","t","e","x","t","{","}","}"],     // extra close
];

describe("SWEEP \\text in matrix cells", () => {
  it("find breaking cases", () => {
    const broken: string[] = [];
    for (const host of HOSTS) {
      const baseDims = dims(host);
      const bodyStart = host.indexOf("}") + 1;
      const bodyEnd = host.lastIndexOf("\\end{");
      const stops = mathCaretOffsets(host).filter((p) => p >= bodyStart && p <= bodyEnd);
      for (const stop of stops) {
        if (!mathMatrixContext(host, stop)) continue;
        for (const seq of SEQS) {
          let state = stateAt(host, stop);
          let bail = false;
          for (const key of seq) {
            const res = state.actionBus.dispatchState(INSERT_TEXT, state, { text: key });
            state = res.state;
            const sel = state.document.selection;
            if (sel && !sel.isCollapsed) { bail = true; break; }
          }
          if (bail) continue;
          const after = latexOf(state);
          const d = dims(after);
          // corruption = env pair broken, no array, or shape changed from base
          const begins = (after.match(/\\begin\{/g) ?? []).length;
          const ends = (after.match(/\\end\{/g) ?? []).length;
          if (d !== baseDims || begins !== 1 || ends !== 1) {
            broken.push(`host=${host}\n  @${stop} seq=${seq.join("")}\n  -> ${after}\n  dims ${baseDims} -> ${d} (b${begins}/e${ends})`);
          }
        }
      }
    }
    expect(broken.join("\n\n") || "NONE").toBe("NONE");
  });
});

/**
 * Line-breaking (wrapped) layout. A formula wider than its width budget is split
 * across rows at binary operators / relations and stacked into one taller box
 * whose baseline stays the first row's. These pin the break placement, the
 * stacking geometry, and the "cut, don't break, when there's nothing to break"
 * fallback.
 */
import { describe, expect, it } from "vitest";

import type { Box } from "./box";
import { layoutMath } from "../index";

/** Depth-first walk yielding every box with its absolute x/y (em). */
function* walk(
  box: Box,
  x = 0,
  y = 0,
): Generator<{ box: Box; x: number; y: number }> {
  yield { box, x, y };
  if (box.type === "list") {
    for (const c of box.children) yield* walk(c.box, x + c.dx, y + c.dy);
  }
}

/** The distinct baseline y of every painted glyph, sorted top→bottom. */
function glyphRows(box: Box): number[] {
  const ys = new Set<number>();
  for (const n of walk(box)) {
    if (n.box.type === "glyph" && n.box.char !== "" && n.box.width > 0) {
      ys.add(Math.round(n.y * 1000) / 1000);
    }
  }
  return [...ys].sort((a, b) => a - b);
}

/** Absolute x of the first glyph matching `char`. */
function glyphX(box: Box, char: string): number {
  for (const n of walk(box)) {
    if (n.box.type === "glyph" && n.box.char === char) return n.x;
  }
  throw new Error(`no glyph '${char}'`);
}

describe("wrapped layout breaks a wide formula across rows", () => {
  // fontSize 1 → widths are in em; a budget of ~4 em forces several rows.
  const wide = "a + b + c + d + e + f + g + h";

  it("a generous budget keeps it on one row", () => {
    const l = layoutMath(wide, {
      fontSize: 1,
      displayMode: true,
      maxWidth: 100,
    });
    expect(glyphRows(l.box)).toHaveLength(1);
  });

  it("a tight budget splits it onto multiple rows", () => {
    const l = layoutMath(wide, { fontSize: 1, displayMode: true, maxWidth: 4 });
    expect(glyphRows(l.box).length).toBeGreaterThan(1);
  });

  it("no row's content exceeds the budget", () => {
    const budget = 4;
    const l = layoutMath(wide, {
      fontSize: 1,
      displayMode: true,
      maxWidth: budget,
    });
    // Group glyph extents by row baseline and check each row's span.
    const rows = new Map<number, { min: number; max: number }>();
    for (const n of walk(l.box)) {
      if (n.box.type !== "glyph" || n.box.width === 0) continue;
      const key = Math.round(n.y * 1000) / 1000;
      const r = rows.get(key) ?? { min: Infinity, max: -Infinity };
      r.min = Math.min(r.min, n.x);
      r.max = Math.max(r.max, n.x + n.box.width);
      rows.set(key, r);
    }
    for (const r of rows.values()) {
      expect(r.max - r.min).toBeLessThanOrEqual(budget + 1e-6);
    }
  });

  it("breaks BEFORE the operator — a continuation row leads with '+'", () => {
    const l = layoutMath(wide, { fontSize: 1, displayMode: true, maxWidth: 4 });
    // Each row's leftmost glyph: rows after the first should start with an operator.
    const rows = new Map<number, { x: number; char: string }>();
    for (const n of walk(l.box)) {
      if (n.box.type !== "glyph" || n.box.width === 0) continue;
      const key = Math.round(n.y * 1000) / 1000;
      const cur = rows.get(key);
      if (!cur || n.x < cur.x) rows.set(key, { x: n.x, char: n.box.char });
    }
    const ordered = [...rows.entries()].sort((a, b) => a[0] - b[0]);
    // First row starts with the operand 'a'; at least one later row leads with '+'.
    expect(ordered[0][1].char).toBe("a");
    expect(ordered.slice(1).some(([, v]) => v.char === "+")).toBe(true);
  });

  it("stacks rows below the baseline (continuation rows have larger y)", () => {
    const l = layoutMath(wide, { fontSize: 1, displayMode: true, maxWidth: 4 });
    const rows = glyphRows(l.box);
    expect(rows[0]).toBeCloseTo(0, 6); // first row sits on the baseline
    for (let i = 1; i < rows.length; i++)
      expect(rows[i]).toBeGreaterThan(rows[i - 1]);
  });

  it("reports total height/depth spanning every row", () => {
    const oneRow = layoutMath(wide, {
      fontSize: 1,
      displayMode: true,
      maxWidth: 100,
    });
    const wrapped = layoutMath(wide, {
      fontSize: 1,
      displayMode: true,
      maxWidth: 4,
    });
    // Baseline (height) is unchanged; the stack hangs further below.
    expect(wrapped.height).toBeCloseTo(oneRow.height, 6);
    expect(wrapped.depth).toBeGreaterThan(oneRow.depth);
  });

  it("indents continuation rows when asked", () => {
    const l = layoutMath(wide, {
      fontSize: 1,
      displayMode: true,
      maxWidth: 4,
      wrapIndent: 1,
    });
    // The list places continuation row sub-boxes at dx = indent (1 em).
    const indents = (l.box.type === "list" ? l.box.children : []).map(
      (c) => c.dx,
    );
    expect(indents[0]).toBeCloseTo(0, 6);
    expect(indents.slice(1).every((d) => Math.abs(d - 1) < 1e-6)).toBe(true);
  });
});

describe("wrapped layout falls back to overflow when nothing can break", () => {
  it("a single wide construct overflows its row rather than breaking", () => {
    // A fraction is one unbreakable top-level atom; a tiny budget cannot split it.
    // (Its numerator/denominator sit on their own baselines, but that is the
    // fraction's internal stacking — the wrapped layout produces a single ROW.)
    const l = layoutMath("\\frac{abcdefgh}{ijklmnop}", {
      fontSize: 1,
      displayMode: true,
      maxWidth: 1,
    });
    const rowCount = l.box.type === "list" ? l.box.children.length : 1;
    expect(rowCount).toBe(1); // not line-broken
    expect(l.width).toBeGreaterThan(1); // overflowed (cut), as designed
  });

  it("preserves the unbroken layout's geometry when it already fits", () => {
    const plain = layoutMath("x + y", { fontSize: 1, displayMode: true });
    const budgeted = layoutMath("x + y", {
      fontSize: 1,
      displayMode: true,
      maxWidth: 100,
    });
    expect(budgeted.width).toBeCloseTo(plain.width, 6);
    expect(glyphX(budgeted.box, "y")).toBeCloseTo(glyphX(plain.box, "y"), 6);
  });
});

describe("wrapped layout keeps a per-row caret structure", () => {
  it("the continuation row's glyphs are caret-reachable on their own baseline", () => {
    const l = layoutMath("a + b + c + d + e + f", {
      fontSize: 1,
      displayMode: true,
      maxWidth: 4,
    });
    // The very last glyph should sit on the last (lowest) row, below the first.
    const rows = glyphRows(l.box);
    const last = [...walk(l.box)]
      .filter((n) => n.box.type === "glyph" && n.box.width > 0)
      .at(-1)!;
    expect(Math.round(last.y * 1000) / 1000).toBeCloseTo(rows.at(-1)!, 3);
  });
});

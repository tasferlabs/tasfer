/**
 * Horizontal-placement regressions. The numeric `oracle.test.ts` pins only
 * vertical metrics (height/depth) against KaTeX, so two horizontal-layout bugs
 * shipped invisibly: a square-root whose surd peaked early and ran flat to the
 * vinculum join (a detached-looking bar stub left of the radicand), and an
 * integral whose sub/superscripts ignored the operator's italic correction
 * (scripts crammed onto the glyph instead of staggered past its slant). These
 * pin the geometry KaTeX produces.
 */
import { describe, expect, it } from "vitest";

import type { Box } from "./box.ts";
import { layoutMath } from "../index.ts";

/** Depth-first walk yielding every box with its absolute x/y (em). */
function* walk(box: Box, x = 0, y = 0): Generator<{ box: Box; x: number; y: number }> {
  yield { box, x, y };
  if (box.type === "list") {
    for (const c of box.children) yield* walk(c.box, x + c.dx, y + c.dy);
  }
}

const layout = (e: string, displayMode = true) =>
  layoutMath(e, { fontSize: 1, displayMode }).box;

describe("square-root surd joins the vinculum", () => {
  it("the surd rises to its right edge with no flat top stub", () => {
    const box = layout("\\sqrt{x}");
    const path = [...walk(box)].find((n) => n.box.type === "path")!.box;
    expect(path.type).toBe("path");
    if (path.type !== "path") return;
    const last = path.commands[path.commands.length - 1];
    // Final point lands at the vinculum join (x === surd width)…
    expect(last[1]).toBeCloseTo(path.width, 3);
    // …and it is the *only* point there — no preceding command shares that x
    // (which is what a flat run to the join would look like).
    const atRight = path.commands.filter((c) => Math.abs(c[1] - path.width) < 1e-6);
    expect(atRight).toHaveLength(1);
  });

  it("the vinculum begins where the surd ends and spans exactly the radicand", () => {
    const box = layout("\\sqrt{x}");
    const inner = [...walk(box)];
    const path = inner.find((n) => n.box.type === "path")!;
    const rule = inner.find((n) => n.box.type === "rule")!;
    const glyph = inner.find((n) => n.box.type === "glyph" && n.box.char === "x")!;
    expect(rule.x).toBeCloseTo(path.x + path.box.width, 3); // bar starts at surd's right
    expect(rule.x).toBeCloseTo(glyph.x, 3); // …aligned with the radicand
    expect(rule.box.width).toBeCloseTo(glyph.box.width, 3); // bar == radicand advance
  });
});

describe("integral scripts stagger past the operator italic", () => {
  it("sup clears the top overhang; sub falls back to the glyph edge", () => {
    const box = layout("\\int_0^\\infty");
    const nodes = [...walk(box)];
    const intGlyph = nodes.find((n) => n.box.type === "glyph" && n.box.char === "∫")!.box;
    const italic = intGlyph.type === "glyph" ? intGlyph.italic : 0;
    expect(italic).toBeGreaterThan(0.3); // the integral leans hard right

    const sup = nodes.find((n) => n.box.type === "glyph" && n.box.char === "∞")!;
    const sub = nodes.find((n) => n.box.type === "glyph" && n.box.char === "0")!;
    // The op's advance includes the italic, so the superscript sits at
    // glyph.width + italic and the subscript at glyph.width — a stagger of one
    // italic correction, exactly KaTeX's `margin-right`/`margin-left` pair.
    expect(sup.x - sub.x).toBeCloseTo(italic, 2);
  });

  it("scripts spread along the tall operator, not parked near the axis", () => {
    // An integral is not a character box, so Rule 18a drops the scripts toward
    // the glyph's own top/bottom. The same scripts on a letter base sit far
    // closer to the baseline; the integral must spread them much more.
    const intab = [...walk(layout("\\int_a^b"))];
    const xab = [...walk(layout("x_a^b"))];
    const g = (ns: typeof intab, ch: string) =>
      ns.find((n) => n.box.type === "glyph" && n.box.char === ch)!;
    const intSpread = g(intab, "a").y - g(intab, "b").y; // sub below − sup above
    const xSpread = g(xab, "a").y - g(xab, "b").y;
    expect(intSpread).toBeGreaterThan(xSpread + 1); // ≈2.0em vs ≈0.8em
    // Matches KaTeX's computed tree: sup ≈ −1.11em, sub ≈ +0.91em.
    expect(g(intab, "b").y).toBeCloseTo(-1.114, 2);
    expect(g(intab, "a").y).toBeCloseTo(0.911, 2);
  });
});

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
    const atRight = path.commands.filter(
      (c) => Math.abs(c[1] - path.width) < 1e-6,
    );
    expect(atRight).toHaveLength(1);
  });

  it("the vinculum begins where the surd ends and spans exactly the radicand", () => {
    const box = layout("\\sqrt{x}");
    const inner = [...walk(box)];
    const path = inner.find((n) => n.box.type === "path")!;
    const rule = inner.find((n) => n.box.type === "rule")!;
    const glyph = inner.find(
      (n) => n.box.type === "glyph" && n.box.char === "x",
    )!;
    expect(rule.x).toBeCloseTo(path.x + path.box.width, 3); // bar starts at surd's right
    expect(rule.x).toBeCloseTo(glyph.x, 3); // …aligned with the radicand
    expect(rule.box.width).toBeCloseTo(glyph.box.width, 3); // bar == radicand advance
  });
});

describe("integral scripts stagger past the operator italic", () => {
  it("sup clears the top overhang; sub falls back to the glyph edge", () => {
    const box = layout("\\int_0^\\infty");
    const nodes = [...walk(box)];
    const intGlyph = nodes.find(
      (n) => n.box.type === "glyph" && n.box.char === "∫",
    )!.box;
    const italic = intGlyph.type === "glyph" ? intGlyph.italic : 0;
    expect(italic).toBeGreaterThan(0.3); // the integral leans hard right

    const sup = nodes.find(
      (n) => n.box.type === "glyph" && n.box.char === "∞",
    )!;
    const sub = nodes.find(
      (n) => n.box.type === "glyph" && n.box.char === "0",
    )!;
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

describe("letter scripts clear italic overhangs", () => {
  it("a superscript on a braced capital V clears its italic correction", () => {
    // Structured math prints script bases as arguments: `{V}^{2}` rather than
    // the visually equivalent `V^2`. The group wrapper must retain V's slant.
    const nodes = [...walk(layout("{V}^{2}", false))];
    const base = nodes.find(
      (n) => n.box.type === "glyph" && n.box.char === "V",
    )!;
    const sup = nodes.find(
      (n) => n.box.type === "glyph" && n.box.char === "2",
    )!;
    expect(base.box.type).toBe("glyph");
    if (base.box.type !== "glyph") return;
    expect(base.box.italic).toBeGreaterThan(0.2);
    expect(sup.x).toBeCloseTo(
      base.x + base.box.width + base.box.italic + 0.05,
      3,
    );
  });

  it("a subscript stays at the advance while the superscript clears the lean", () => {
    const nodes = [...walk(layout("{V}_{a}^{b}", false))];
    const base = nodes.find(
      (n) => n.box.type === "glyph" && n.box.char === "V",
    )!;
    const sup = nodes.find(
      (n) => n.box.type === "glyph" && n.box.char === "b",
    )!;
    const sub = nodes.find(
      (n) => n.box.type === "glyph" && n.box.char === "a",
    )!;
    expect(base.box.type).toBe("glyph");
    if (base.box.type !== "glyph") return;
    expect(sub.x).toBeCloseTo(base.x + base.box.width, 3);
    expect(sup.x - sub.x).toBeCloseTo(base.box.italic + 0.05, 3);
  });
});

describe("math-italic atoms keep their trailing correction", () => {
  it("separates adjacent variables in an accented product", () => {
    const nodes = [...walk(layout("\\Delta P\\dot{V}", false))];
    const p = nodes.find((n) => n.box.type === "glyph" && n.box.char === "P")!;
    const v = nodes.find((n) => n.box.type === "glyph" && n.box.char === "V")!;
    expect(p.box.type).toBe("glyph");
    if (p.box.type !== "glyph") return;

    expect(p.box.italic).toBeGreaterThan(0.1);
    expect(v.x).toBeCloseTo(p.x + p.box.width + p.box.italic, 3);
  });

  it("keeps an accented subscript at the glyph edge", () => {
    const nodes = [...walk(layout("\\dot{V}_i", false))];
    const v = nodes.find((n) => n.box.type === "glyph" && n.box.char === "V")!;
    const sub = nodes.find(
      (n) => n.box.type === "glyph" && n.box.char === "i",
    )!;
    expect(v.box.type).toBe("glyph");
    if (v.box.type !== "glyph") return;

    expect(sub.x).toBeCloseTo(v.x + v.box.width, 3);
  });
});

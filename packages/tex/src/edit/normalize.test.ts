/**
 * Materializing incomplete constructs into canonical placeholder form. A bare
 * `\frac` has no source text between its slots, so both collapse to one offset
 * and the caret can't enter either — filling the `{}` braces gives each slot a
 * real position. The transform is pure, idempotent, and reports the insertions
 * + caret remap a host needs to apply it as a consistent edit.
 */
import { normalizeLatex } from "./normalize.ts";
import { caretStops } from "./caret.ts";
import { layoutMath } from "../index.ts";
import { describe, expect, it } from "vitest";

describe("normalizeLatex", () => {
  it("fills a bare fraction's two slots", () => {
    const n = normalizeLatex("\\frac");
    expect(n.changed).toBe(true);
    expect(n.latex).toBe("\\frac{}{}");
    // One merged insert of `{}{}` at the command's end (offset 5).
    expect(n.inserts).toEqual([{ at: 5, text: "{}{}" }]);
  });

  it("lands the caret inside the numerator after completing `\\frac`", () => {
    const n = normalizeLatex("\\frac");
    // Caret was at the end (5); it should sit between the first `{}` (6).
    expect(n.mapCaret(5)).toBe(6);
    // The start of the command is unmoved.
    expect(n.mapCaret(0)).toBe(0);
  });

  it("fills only a missing denominator, leaving a present numerator", () => {
    const n = normalizeLatex("\\frac{a}");
    expect(n.latex).toBe("\\frac{a}{}");
    expect(n.inserts).toEqual([{ at: 8, text: "{}" }]);
    // Caret after the `}` (8) drops into the new denominator (9).
    expect(n.mapCaret(8)).toBe(9);
  });

  it("fills a bare square root and an empty script", () => {
    expect(normalizeLatex("\\sqrt").latex).toBe("\\sqrt{}");
    expect(normalizeLatex("x^").latex).toBe("x^{}");
    expect(normalizeLatex("\\vec").latex).toBe("\\vec{}");
  });

  it("fills nested incomplete constructs", () => {
    expect(normalizeLatex("\\frac{\\sqrt}{}").latex).toBe("\\frac{\\sqrt{}}{}");
  });

  it("is idempotent on already-braced constructs", () => {
    for (const s of ["\\frac{}{}", "\\sqrt{}", "x^{}", "\\frac{a}{b}", "a+b"]) {
      const n = normalizeLatex(s);
      expect(n.changed).toBe(false);
      expect(n.latex).toBe(s);
      expect(n.inserts).toEqual([]);
    }
  });

  it("leaves a single-atom TeX argument untouched (already navigable)", () => {
    // `\frac12` is valid: num=1, den=2 — distinct offsets already, no braces needed.
    const n = normalizeLatex("\\frac12");
    expect(n.changed).toBe(false);
    expect(n.latex).toBe("\\frac12");
  });

  it("does nothing to an empty formula", () => {
    const n = normalizeLatex("");
    expect(n.changed).toBe(false);
    expect(n.latex).toBe("");
  });

  it("gives the materialized slots distinct caret stops", () => {
    // The whole point: bare `\frac` collapses; the normalized form does not.
    const bare = caretStops(layoutMath("\\frac", { fontSize: 16 }));
    const bareSlots = new Set(bare.map((s) => s.offset));
    // Normalized: numerator (6) and denominator (8) are distinct, landable stops.
    const full = caretStops(layoutMath("\\frac{}{}", { fontSize: 16 }));
    const offsets = new Set(full.map((s) => s.offset));
    expect(offsets.has(6)).toBe(true);
    expect(offsets.has(8)).toBe(true);
    // Sanity: the bare form genuinely has fewer distinct interior stops.
    expect(offsets.size).toBeGreaterThan(bareSlots.size);
  });
});

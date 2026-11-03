import { enclosingSelectionRanges } from "./unit";
import { describe, expect, it } from "vitest";

/** Every rung from a caret at `at`, smallest strictly-enclosing first. */
function ladder(latex: string, at: number): string[] {
  const out: string[] = [];
  let from = at;
  let to = at;
  for (;;) {
    let best: { start: number; end: number } | null = null;
    for (const r of enclosingSelectionRanges(latex, from, to)) {
      if (r.start > from || r.end < to) continue;
      if (r.start === from && r.end === to) continue;
      if (!best || r.end - r.start < best.end - best.start) best = r;
    }
    if (!best) return out;
    out.push(latex.slice(best.start, best.end));
    from = best.start;
    to = best.end;
  }
}

describe("enclosingSelectionRanges", () => {
  it("climbs symbol → slot → construct → parent slot → formula", () => {
    const latex = "x+\\frac{a+b}{c}";
    expect(ladder(latex, latex.indexOf("+b"))).toEqual([
      "+",
      "a+b",
      "\\frac{a+b}{c}",
      latex,
    ]);
  });

  it("walks out through nested constructs one level at a time", () => {
    const latex = "\\sqrt{\\frac{1}{x^{2}}}";
    expect(ladder(latex, latex.indexOf("2"))).toEqual([
      "2",
      "x^{2}",
      "\\frac{1}{x^{2}}",
      latex,
    ]);
  });

  it("an empty formula has nowhere to go", () => {
    expect(ladder("", 0)).toEqual([]);
  });
});

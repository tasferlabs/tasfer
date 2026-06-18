/**
 * Construct boundary stops: a multi-part construct (fraction, root, script) can
 * be exited to the parent baseline. Without these, a construct at the end of the
 * line has caret stops only on its inner rows, so the caret at its right edge
 * renders down in the denominator / up on the script row instead of beside the
 * whole construct — and pressing → never reaches a top-level position.
 */
import { caretRect, caretStops, caretVertical } from "./caret.ts";
import { layoutMath } from "../index.ts";
import { describe, expect, it } from "vitest";

const FS = 16;

describe("construct boundary stops — exit to top level", () => {
  it("the right edge of a trailing fraction sits on the main baseline", () => {
    // `\frac{a}{b}`: offset 11 is the end. It must render beside the whole
    // fraction (x ≈ full width, baseline) — NOT down at the denominator's end.
    const l = layoutMath("\\frac{a}{b}", { fontSize: FS });
    const den = caretStops(l).find((s) => s.offset === 10)!; // `b` right edge
    const end = caretRect(l, 11)!;
    expect(end.x).toBeCloseTo(l.width, 0);
    // The denominator row hangs below the baseline; the exit caret spans the
    // whole fraction, so it reaches higher (a more negative top).
    expect(end.top).toBeLessThan(den.top);
  });

  it("the left edge of a leading fraction sits on the main baseline", () => {
    const l = layoutMath("\\frac{a}{b}", { fontSize: FS });
    const start = caretRect(l, 0)!;
    expect(start.x).toBeCloseTo(0, 1);
    expect(start.top).toBeLessThan(0); // tall caret beside the fraction
  });

  it("exiting a superscript lands beside the construct, not on the script row", () => {
    // `x^2`: offset 3 is both the end of the `2` and the end of `x^2`. The caret
    // there should be on the main baseline (bottom ≈ 0), beside the construct.
    const l = layoutMath("x^2", { fontSize: FS });
    const end = caretRect(l, 3)!;
    expect(end.x).toBeCloseTo(l.width, 0);
    expect(end.bottom).toBeCloseTo(0, 1);
  });

  it("boundary stops do not divert vertical navigation between rows", () => {
    // ↑ from the denominator still reaches the numerator slot, not the
    // main-baseline boundary stop that sits between the two rows.
    const l = layoutMath("\\frac{a}{b}", { fontSize: FS });
    const den = caretStops(l).find((s) => s.offset === 9)!; // denominator `b`
    const up = caretVertical(l, 9, "up", den.x);
    expect(up).toBe(6); // numerator `a`
  });
});

/**
 * Construct boundary stops: a multi-part construct (fraction, root, script) can
 * be exited to the parent baseline. Without these, a construct at the end of the
 * line has caret stops only on its inner rows, so the caret at its right edge
 * renders down in the denominator / up on the script row instead of beside the
 * whole construct — and pressing → never reaches a top-level position.
 */
import { caretRect, caretStops, caretVertical } from "./caret";
import { layoutMath } from "../index";
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

  it("a caret before a following construct keeps the PRECEDING height, not the construct's", () => {
    // `\det\left(\frac{a}{b}\right)`: offset 4 sits between `\det` and the
    // delimited construct. The op's med/thick space keeps `\det`'s trailing edge
    // (short, main baseline) and the construct's LEADING boundary (tall, full
    // delimiter height) from de-duplicating. A bare caret there must take `\det`'s
    // height — the content it follows — not leap to the full height of the matrix
    // it has not yet entered (the reported bug: a huge caret beside `det`).
    const l = layoutMath("\\det\\left(\\frac{a}{b}\\right)", {
      fontSize: 22,
      displayMode: true,
    });
    const detEnd = caretStops(l).find((s) => s.offset === 4 && !s.boundary)!; // `\det`'s trailing edge
    const caret = caretRect(l, 4)!;
    expect(caret.x).toBeCloseTo(detEnd.x, 1); // rests at the op's edge, not the delimiter's
    expect(caret.bottom - caret.top).toBeCloseTo(detEnd.bottom - detEnd.top, 1);
    // …and it is far shorter than the whole delimited construct beside it.
    const whole = caretRect(l, "\\det\\left(\\frac{a}{b}\\right)".length)!;
    expect(caret.bottom - caret.top).toBeLessThan(
      (whole.bottom - whole.top) / 2,
    );
  });

  it("a TRAILING boundary still wins so the caret exits beside the construct", () => {
    // The complement of the above: after the whole delimited construct (end of
    // source), the trailing boundary must win so the caret spans the construct it
    // just left — on the main baseline, not up in the fraction.
    const l = layoutMath("\\det\\left(\\frac{a}{b}\\right)", {
      fontSize: 22,
      displayMode: true,
    });
    const end = caretRect(l, "\\det\\left(\\frac{a}{b}\\right)".length)!;
    expect(end.bottom).toBeCloseTo(l.depth, 0); // reaches the construct's full depth
    expect(end.top).toBeCloseTo(-l.height, 0); // …and its full height
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

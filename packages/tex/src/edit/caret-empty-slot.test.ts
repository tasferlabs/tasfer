/**
 * Empty-slot caret stops (live-editing step 3b). An empty group `{}` lays out to
 * a faint placeholder box that, unlike the nothing it used to produce, carries a
 * caret stop *between* its braces — so a slot emptied by deletion (`\frac{a}{b}`
 * → `\frac{}{b}`) stays clickable, arrow-navigable, and typeable. The stop sits
 * on the slot's own row (a numerator above the bar, a superscript raised off the
 * baseline), which both places the caret correctly and lets ↑/↓ reach it.
 */
import { caretStops, caretVertical, hitTest } from "./caret";
import { layoutMath } from "../index";
import { describe, expect, it } from "vitest";

const FS = 16;

describe("empty-slot caret stops", () => {
  it("an empty numerator gets a stop between its braces, on the numerator row", () => {
    // \frac{}{b}: '{' at 5, '}' at 6 → the inside offset is 6.
    const layout = layoutMath("\\frac{}{b}", { fontSize: FS });
    const stops = caretStops(layout);

    const slot = stops.find((s) => s.offset === 6);
    expect(slot).toBeDefined();

    // The denominator 'b' (index 8) sits on a lower row (+y is down), so the
    // empty numerator's row baseline must be strictly above it.
    const den = stops.find((s) => s.offset === 8)!;
    expect(slot!.y).toBeLessThan(den.y);
  });

  it("a click in the numerator region resolves to the empty slot", () => {
    const layout = layoutMath("\\frac{}{b}", { fontSize: FS });
    const slot = caretStops(layout).find((s) => s.offset === 6)!;
    // Click right at the slot's center, on its row.
    expect(hitTest(layout, slot.x, (slot.top + slot.bottom) / 2)).toBe(6);
  });

  it("an empty text group gets a stop between its braces", () => {
    const layout = layoutMath("\\text{}", { fontSize: FS });
    const slot = caretStops(layout).find((s) => s.offset === 6);
    expect(slot).toBeDefined();
    expect(hitTest(layout, slot!.x, (slot!.top + slot!.bottom) / 2)).toBe(6);
  });

  it("an empty text group inside a matrix cell stays reachable", () => {
    const latex = "\\begin{matrix}a\\text{}&b\\end{matrix}";
    const layout = layoutMath(latex, { fontSize: FS });
    const slot = caretStops(layout).find(
      (s) => s.offset === "\\begin{matrix}a\\text{".length,
    );
    expect(slot).toBeDefined();
    expect(hitTest(layout, slot!.x, (slot!.top + slot!.bottom) / 2)).toBe(
      "\\begin{matrix}a\\text{".length,
    );
  });

  it("enlarges an empty slot's hit target without changing its visual box", () => {
    const layout = layoutMath("\\frac{}{b}", { fontSize: FS });
    const slot = caretStops(layout).find((s) => s.offset === 6)!;

    expect(
      hitTest(layout, slot.x + 16, (slot.top + slot.bottom) / 2, {
        placeholderTargetSize: 44,
      }),
    ).toBe(6);
  });

  it("does not let an enlarged empty numerator steal a denominator click", () => {
    const layout = layoutMath("\\frac{}{b}", { fontSize: FS });
    const den = caretStops(layout).find((s) => s.offset === 8)!;

    expect(
      hitTest(layout, den.x, (den.top + den.bottom) / 2, {
        placeholderTargetSize: 44,
      }),
    ).toBe(8);
  });

  it("↑ from the denominator reaches the empty numerator slot", () => {
    const layout = layoutMath("\\frac{}{b}", { fontSize: FS });
    const den = caretStops(layout).find((s) => s.offset === 8)!;
    const up = caretVertical(layout, 8, "up", den.x);
    expect(up).toBe(6);
  });

  it("an empty superscript gets a raised stop", () => {
    // x^{}: 'x' at 0, '^' at 1, '{' at 2, '}' at 3 → inside offset 3.
    const layout = layoutMath("x^{}", { fontSize: FS });
    const stops = caretStops(layout);
    const base = stops.find((s) => s.offset === 0)!; // 'x' left edge (baseline)
    const sup = stops.find((s) => s.offset === 3);
    expect(sup).toBeDefined();
    // The whole superscript caret is shifted up off the baseline.
    expect(sup!.top).toBeLessThan(base.top);
  });

  it("a slot holding only spacing reads as an empty, reachable slot", () => {
    // `\frac{\ }{}`: the numerator is a lone `\ ` control space — the separator a
    // host inserts to keep a just-typed command-entry `\` off the slot's `}`. It
    // paints no ink, so the slot must still get a placeholder stop (a box the caret
    // can land in) instead of a dead, unreachable gap. Compared side by side with
    // the truly-empty `\frac{}{}`, the numerator placeholder must be present and
    // sit on a row above the denominator.
    const layout = layoutMath("\\frac{\\ }{}", { fontSize: FS });
    const stops = caretStops(layout);
    const num = stops.find((s) => s.placeholder && s.y < 0);
    expect(num).toBeDefined();
    // A click centered on the numerator placeholder resolves to it, so the slot is
    // genuinely editable (not skipped over to the denominator).
    expect(hitTest(layout, num!.x, (num!.top + num!.bottom) / 2)).toBe(
      num!.offset,
    );
  });

  it("a non-empty formula has no placeholder stops", () => {
    const layout = layoutMath("a+b", { fontSize: FS });
    // Every stop maps to a real source offset in [0, 3]; nothing synthetic.
    for (const s of caretStops(layout)) {
      expect(s.offset).toBeGreaterThanOrEqual(0);
      expect(s.offset).toBeLessThanOrEqual(3);
    }
  });
});

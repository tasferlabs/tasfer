/**
 * Clicking an inline-math chip that is embedded in a mixed-direction (bidi) line
 * must place the caret INSIDE the formula, the same as on a pure LTR line.
 *
 * A chip's LaTeX is Latin, so in an RTL (Arabic) paragraph it becomes an
 * embedded LTR run and the line is resolved through the bidi hit-test path. That
 * path used to return a run boundary without descending into the chip, so the
 * math could neither be entered nor selected. See computeSelectionRects /
 * positionWithinLine.
 */
import { selectWordAtPosition } from "../actions/actions";
import { createDefaultMarkRegistry } from "../rendering/marks";
import { loadPage } from "../serlization/loadPage";
import { createInitialState } from "../state-utils";
import { resolveTheme } from "../styles";
import { TextNode, type TextualBlock } from "./TextNode";
import { describe, expect, it } from "vitest";

describe("TextNode inline-math chip click inside a bidi (RTL) line", () => {
  const styles = resolveTheme({});
  const marks = createDefaultMarkRegistry();
  const node = new TextNode();

  const chipRange = (layout: ReturnType<TextNode["computeLayout"]>) => {
    const text = layout.chars.map((c) => c.char).join("");
    const start = text.indexOf("x");
    return { start, end: start + 3 }; // "x^2"
  };

  const landsInside = (
    block: TextualBlock,
    layout: ReturnType<TextNode["computeLayout"]>,
  ) => {
    const { start, end } = chipRange(layout);
    // The chip sits on the last line (after any Arabic prefix / wrap).
    const line =
      layout.lines.find((l) => start >= l.startIndex && start < l.endIndex) ??
      layout.lines[layout.lines.length - 1];
    const leftX = node.caretRect(layout, start, 0, 0).x;
    const rightX = node.caretRect(layout, end, 0, 0).x;
    const midY = line.y + line.height / 2;
    const lo = Math.min(leftX, rightX);
    const hi = Math.max(leftX, rightX);
    for (let frac = 0.2; frac < 1; frac += 0.2) {
      const x = lo + (hi - lo) * frac;
      const index = node.positionFromPoint(block, layout, x, midY, 0, 0);
      expect(index).toBeGreaterThan(start);
      expect(index).toBeLessThan(end);
    }
  };

  it("Arabic word + chip on a wide line", () => {
    const block = loadPage("اااا $x^2$").blocks[0] as TextualBlock;
    const layout = node.computeLayout(block, 1000, styles, undefined, marks);
    expect(layout.isRTL).toBe(true);
    landsInside(block, layout);
  });

  it("Arabic word + chip on a narrow line (chip pushed by wrap)", () => {
    const block = loadPage("اااا اتاااار كلمة أخرى $x^2$")
      .blocks[0] as TextualBlock;
    const layout = node.computeLayout(block, 120, styles, undefined, marks);
    expect(layout.isRTL).toBe(true);
    expect(layout.lines.length).toBeGreaterThan(1);
    landsInside(block, layout);
  });

  // Double-click (selectWordAtPosition): an interior chip index must select the
  // WHOLE chip atomically — not a raw-LaTeX sub-token, and not nothing when the
  // interior char is a non-word char like `^`. Same in LTR and RTL.
  const wholeChip = (content: string) => {
    const page = loadPage(content);
    const block = page.blocks[0] as TextualBlock;
    const layout = node.computeLayout(block, 1000, styles, undefined, marks);
    const { start, end } = chipRange(layout);
    const state = createInitialState(page);
    // Interior index landing on `^` — a non-word char, the worst case.
    const sel = selectWordAtPosition(state, {
      blockIndex: 0,
      textIndex: start + 1,
    }).document.selection;
    return { sel, start, end };
  };

  it("double-click inside the chip selects the whole chip (LTR)", () => {
    const { sel, start, end } = wholeChip("aa $x^2$");
    expect(sel?.anchor.textIndex).toBe(start);
    expect(sel?.focus.textIndex).toBe(end);
  });

  it("double-click inside the chip selects the whole chip (RTL/bidi)", () => {
    const { sel, start, end } = wholeChip("اااا $x^2$");
    expect(sel?.anchor.textIndex).toBe(start);
    expect(sel?.focus.textIndex).toBe(end);
  });
});

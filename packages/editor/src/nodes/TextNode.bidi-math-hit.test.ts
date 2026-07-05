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
  // CONSTRUCT under the caret atomically — not a raw-LaTeX sub-token, and not
  // nothing when the interior char is a non-word char like `^`. For `x^2` the
  // whole chip IS one script construct, so the construct == the whole chip. Same
  // in LTR and RTL.
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

  it("double-click inside a single-construct chip selects the whole chip (LTR)", () => {
    const { sel, start, end } = wholeChip("aa $x^2$");
    expect(sel?.anchor.textIndex).toBe(start);
    expect(sel?.focus.textIndex).toBe(end);
  });

  it("double-click inside a single-construct chip selects the whole chip (RTL/bidi)", () => {
    const { sel, start, end } = wholeChip("اااا $x^2$");
    expect(sel?.anchor.textIndex).toBe(start);
    expect(sel?.focus.textIndex).toBe(end);
  });

  // A multi-construct chip: a double-tap inside the `\sqrt{x}` takes just that
  // construct, leaving the trailing `+1` unselected — the "first construct under
  // the caret", not the whole chip.
  it("double-click inside a multi-construct chip selects only that construct", () => {
    const page = loadPage("aa $\\sqrt{x}+1$");
    const block = page.blocks[0] as TextualBlock;
    const layout = node.computeLayout(block, 1000, styles, undefined, marks);
    const text = layout.chars.map((c) => c.char).join("");
    const chipStart = text.indexOf("\\sqrt");
    const state = createInitialState(page);
    // A finger landing inside the root's body (the `x`, chip-local offset 6).
    const sel = selectWordAtPosition(state, {
      blockIndex: 0,
      textIndex: chipStart + 6,
    }).document.selection;
    expect(sel?.anchor.textIndex).toBe(chipStart);
    expect(sel?.focus.textIndex).toBe(chipStart + "\\sqrt{x}".length);
  });
});

// A chip whose whole content is a single ATOMIC command (`\det`, `\sin`, `\lim`)
// has caret stops only at its two edges, so a double-click resolves the POSITION
// to a chip boundary — the offset word-select can't see it. It must instead be
// resolved from the POINT: `wordRangeFromPoint` descends into the chip's box tree
// (via tex `spanAtPoint`), where the command's glyphs carry its whole span, so the
// double-click selects `\det` whole. This is what makes atomic commands selectable
// at all (desktop click and mobile tap both route through here).
describe("TextNode double-click on an atomic-command chip (\\det) by point", () => {
  const styles = resolveTheme({});
  const marks = createDefaultMarkRegistry();
  const node = new TextNode();

  it("resolves the whole command from a point anywhere over the chip", () => {
    const page = loadPage("$\\det$ aa");
    const block = page.blocks[0] as TextualBlock;
    const layout = node.computeLayout(block, 1000, styles, undefined, marks);
    const text = layout.chars.map((c) => c.char).join("");
    expect(text.startsWith("\\det")).toBe(true);
    // The chip occupies block indices [0, 4). Its drawn x-extent is between the
    // caret rects at those two edges; sample across it.
    const leftX = node.caretRect(layout, 0, 0, 0).x;
    const rightX = node.caretRect(layout, 4, 0, 0).x;
    const line = layout.lines[0];
    const midY = layout.insetY + line.y + line.height / 2;
    let hits = 0;
    for (let f = 0.15; f < 1; f += 0.15) {
      const x = leftX + (rightX - leftX) * f;
      const range = node.wordRangeFromPoint(layout, x, midY, 0, 0);
      expect(range).toEqual({ start: 0, end: 4 });
      hits++;
    }
    expect(hits).toBeGreaterThan(0);
  });

  it("selectWordAtPosition applies a caller-resolved point range verbatim", () => {
    const page = loadPage("$\\det$ aa");
    const state = createInitialState(page);
    // The position resolves to a chip boundary (0), but the point range is [0,4].
    const sel = selectWordAtPosition(
      state,
      { blockIndex: 0, textIndex: 0 },
      { start: 0, end: 4 },
    ).document.selection;
    expect(sel?.anchor.textIndex).toBe(0);
    expect(sel?.focus.textIndex).toBe(4);
  });

  it("without the point range, an offset on the chip boundary selects nothing", () => {
    // Proves the regression's cause: the offset path alone cannot select `\det`.
    const page = loadPage("$\\det$ aa");
    const state = createInitialState(page);
    const sel = selectWordAtPosition(state, {
      blockIndex: 0,
      textIndex: 0,
    }).document.selection;
    // Boundary offset, `\` is not a word char → no selection from the offset path.
    expect(sel == null || sel.isCollapsed).toBe(true);
  });
});

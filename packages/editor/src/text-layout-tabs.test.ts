/**
 * A tab is as wide as four spaces. Canvas text drawing turns a tab into one
 * space, so tab-indented source looked flat. Measuring widens it (`expandTabs`
 * in `measureCtxText`), and every geometry pass — wrap, caret, hit-test — reads
 * that one measurement, so they all agree with the widened paint.
 */

import { expandTabs, notifyFontsChanged } from "./fonts";
import type { Char } from "./serlization/loadPage";
import { resolveTheme } from "./styles";
import { layoutText, textCaretRect, textOffsetAtPoint } from "./text-layout";
import { beforeAll, describe, expect, it } from "vitest";

const SPACE = 5;

// The way a canvas measures: a tab is one space wide.
beforeAll(() => {
  const g = globalThis as unknown as {
    document: { createElement: () => unknown };
  };
  g.document.createElement = () =>
    ({
      getContext: () => ({
        measureText: (t: string) => ({
          width: t.length * SPACE,
          fontBoundingBoxAscent: 12,
          fontBoundingBoxDescent: 4,
        }),
        set font(_v: string) {},
        set direction(_v: string) {},
      }),
      style: {},
      setAttribute: () => {},
      appendChild: () => {},
    }) as unknown;
  notifyFontsChanged();
});

const styles = resolveTheme({});

function box(text: string, width = 2000) {
  const chars: Char[] = Array.from({ length: text.length }, (_, i) => ({
    id: `p:${i}`,
    char: text[i],
  }));
  return layoutText({
    chars,
    formats: [],
    width,
    textStyle: styles.blocks.code,
    fontFamily: "mono",
    fonts: styles.fonts,
    direction: "ltr",
  });
}

describe("tab width", () => {
  it("draws each tab as four spaces and leaves other text alone", () => {
    expect(expandTabs("\tif x:\n\t\treturn")).toBe("    if x:\n        return");
    expect(expandTabs("no tabs")).toBe("no tabs");
  });

  it("measures a tab-indented line like the same line indented with spaces", () => {
    expect(box("\t\tx").lines[0].width).toBe(box("        x").lines[0].width);
  });

  it("puts the caret after a tab four spaces in", () => {
    const layout = box("\tx");
    expect(textCaretRect(layout, 0).x).toBe(0);
    expect(textCaretRect(layout, 1).x).toBe(4 * SPACE);
    expect(textCaretRect(layout, 2).x).toBe(5 * SPACE);
  });

  it("maps a click on the tab's span to its nearer edge", () => {
    const layout = box("\tx");
    expect(textOffsetAtPoint(layout, SPACE, 1)).toBe(0);
    expect(textOffsetAtPoint(layout, 3 * SPACE, 1)).toBe(1);
    expect(textOffsetAtPoint(layout, 4.4 * SPACE, 1)).toBe(1);
  });

  it("wraps with the widened tab", () => {
    // 4 + 4 + 1 spaces wide: fits 45px, not 40px.
    expect(box("\t\tx", 45).lines).toHaveLength(1);
    expect(box("\t\tx", 40).lines.length).toBeGreaterThan(1);
  });
});

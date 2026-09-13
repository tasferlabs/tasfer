import { isMidSurrogatePair } from "./code-points";
import { notifyFontsChanged } from "./fonts";
import type { Char } from "./serlization/loadPage";
import { resolveTheme } from "./styles";
import {
  compositionRects,
  foldComposition,
  layoutText,
  lineEdges,
  type TextAlign,
  textCaretRect,
  textOffsetAtPoint,
  textRangeRects,
} from "./text-layout";
import { beforeAll, describe, expect, it } from "vitest";

// Width depends on which UTF-16 units are measured, so a lone surrogate half
// gets an advance of its own — the way a canvas draws it as a missing glyph.
beforeAll(() => {
  const g = globalThis as unknown as {
    document: { createElement: () => unknown };
  };
  g.document.createElement = () =>
    ({
      getContext: () => ({
        measureText: (t: string) => ({
          width: [...t].reduce((w, _c, i) => w + 5 + (t.charCodeAt(i) % 7), 0),
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

function box(
  text: string,
  options: { width?: number; rtl?: boolean; align?: TextAlign } = {},
) {
  // One char per UTF-16 unit, the way stored text is split.
  const chars: Char[] = Array.from({ length: text.length }, (_, i) => ({
    id: `p:${i}`,
    char: text[i],
  }));
  return layoutText({
    chars,
    formats: [],
    width: options.width ?? 2000,
    textStyle: styles.blocks.paragraph,
    fontFamily: "sans",
    fonts: styles.fonts,
    direction: options.rtl ? "rtl" : "ltr",
    align: options.align,
  });
}

describe("text click → offset", () => {
  const cases = {
    "LTR with emoji": { text: "a👍b 👨‍👩‍👧 x 🇸🇦 end" },
    "RTL with emoji": { text: "مرحبا 👍 بالعالم 🇸🇦", rtl: true },
    "mixed direction with emoji": { text: "hello مرحبا 👍 world 🇸🇦 مرحبا" },
  };

  for (const [name, { text, ...options }] of Object.entries(cases)) {
    it(`never lands inside an emoji: ${name}`, () => {
      const layout = box(text, options);
      for (let x = -10; x < layout.width + 10; x += 0.5) {
        const offset = textOffsetAtPoint(layout, x, 5);
        expect(isMidSurrogatePair(text, offset), `x=${x} → ${offset}`).toBe(
          false,
        );
      }
    });
  }

  it("a click on a caret's own x returns that caret's offset", () => {
    const text = "one two three";
    const layout = box(text);
    for (let offset = 0; offset <= text.length; offset++) {
      const caret = textCaretRect(layout, offset);
      expect(textOffsetAtPoint(layout, caret.x, caret.y + 1)).toBe(offset);
    }
  });
});

describe("aligned lines", () => {
  it("places a line at its left, centre or right edge", () => {
    const at = (align: TextAlign, rtl = false) =>
      lineEdges({ width: 100, isRTL: rtl, align }, { width: 40 });
    expect(at(null)).toEqual({ left: 0, right: 40 });
    expect(at(null, true)).toEqual({ left: 60, right: 100 });
    expect(at("center")).toEqual({ left: 30, right: 70 });
    expect(at("right")).toEqual({ left: 60, right: 100 });
    expect(at("left", true)).toEqual({ left: 0, right: 40 });
  });

  it("pins an overflowing line's reading start to the box edge", () => {
    const at = (align: TextAlign, rtl: boolean) =>
      lineEdges({ width: 30, isRTL: rtl, align }, { width: 40 });
    for (const align of [null, "left", "center", "right"] as const) {
      expect(at(align, false).left).toBe(0);
      expect(at(align, true).right).toBe(30);
    }
  });

  it("caret, click and selection follow the aligned edge", () => {
    const text = "abc";
    const left = box(text, { width: 200 });
    const centred = box(text, { width: 200, align: "center" });
    const shift = (200 - left.lines[0].width) / 2;
    for (let offset = 0; offset <= text.length; offset++) {
      const a = textCaretRect(left, offset);
      const b = textCaretRect(centred, offset);
      expect(b.x - a.x).toBeCloseTo(shift, 6);
      expect(textOffsetAtPoint(centred, b.x, 1)).toBe(offset);
    }
    const [rect] = textRangeRects(centred, 1, 2);
    expect(rect.x).toBeCloseTo(textCaretRect(centred, 1).x, 6);
    expect(rect.x + rect.width).toBeCloseTo(textCaretRect(centred, 2).x, 6);
  });
});

describe("composition preview", () => {
  const visible = (chars: readonly Char[]) =>
    chars
      .filter((c) => !c.deleted)
      .map((c) => c.char)
      .join("");

  it("folds the preview in at a visible offset, past tombstones before it", () => {
    const chars: Char[] = [
      { id: "p:0", char: "a" },
      { id: "p:1", char: "x", deleted: true },
      { id: "p:2", char: "b" },
    ];
    const folded = foldComposition(chars, 1, "日本");

    expect(visible(folded.chars)).toBe("a日本b");
    expect(folded.chars.map((c) => c.id)).toEqual([
      "p:0",
      "p:1",
      "composition-0",
      "composition-1",
      "p:2",
    ]);
    expect(folded.compositionRange).toEqual({ start: 1, end: 3 });
  });

  it("splits an emoji in the preview into UTF-16 units, like stored text", () => {
    const folded = foldComposition([{ id: "p:0", char: "a" }], 1, "👍");

    expect(folded.chars).toHaveLength(3);
    expect(visible(folded.chars)).toBe("a👍");
    expect(folded.compositionRange).toEqual({ start: 1, end: 3 });
  });

  it("hides the range a commit will replace", () => {
    const chars: Char[] = Array.from("one two", (char, i) => ({
      id: `p:${i}`,
      char,
    }));
    const folded = foldComposition(chars, 0, "x", { from: 0, to: 3 });

    expect(visible(folded.chars)).toBe("x two");
    // Hidden, not dropped: the ids marks anchor to are still there.
    expect(folded.chars.map((c) => c.id)).toContain("p:2");
  });

  it("underlines exactly the preview", () => {
    const chars: Char[] = Array.from("ab", (char, i) => ({
      id: `p:${i}`,
      char,
    }));
    const { chars: folded, compositionRange } = foldComposition(chars, 1, "xy");
    const layout = layoutText({
      chars: folded,
      formats: [],
      width: 2000,
      textStyle: styles.blocks.paragraph,
      fontFamily: "sans",
      fonts: styles.fonts,
      direction: "ltr",
      compositionRange,
    });
    const [rect] = compositionRects(layout);

    expect(rect.x).toBeCloseTo(textCaretRect(layout, 1).x, 6);
    expect(rect.x + rect.width).toBeCloseTo(textCaretRect(layout, 3).x, 6);
  });
});

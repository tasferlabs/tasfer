/**
 * Recorded text geometry: where the caret, a click and a selection land in
 * every textual node, for a spread of content.
 *
 * The text engine's geometry is being moved out of `TextNode` into shared
 * functions. That move must not shift a single caret or highlight, so this
 * suite records the numbers the nodes produce and fails on any difference.
 * A deliberate geometry change updates the snapshot in the same change, where
 * the diff shows exactly what moved.
 *
 * Lives in the math package because it is the one place every textual node —
 * paragraph, heading, list, quote, display math — and the inline-math chip are
 * installed together.
 */
import { createMathTestMarkRegistry, loadMathPage } from "./__testutils__/math";
import { createMathTestNodeRegistry } from "./__testutils__/math";
import { notifyFontsChanged } from "@tasfer/editor/fonts";
import { TextNode, type TextualBlock } from "@tasfer/editor/nodes/TextNode";
import { resolveTheme } from "@tasfer/editor/styles";
import { getVisibleTextFromRuns } from "@tasfer/editor/sync/char-runs";
import { beforeAll, describe, expect, it } from "vitest";

// Width depends on WHICH characters are measured, not just how many, so an
// off-by-one index shows up as a different x instead of hiding behind uniform
// advances.
function advance(text: string): number {
  let width = 0;
  for (let i = 0; i < text.length; i++) {
    width += 5 + (text.charCodeAt(i) % 7);
  }
  return width;
}

beforeAll(() => {
  const g = globalThis as unknown as {
    document: { createElement: () => unknown };
  };
  g.document.createElement = () =>
    ({
      getContext: () => ({
        measureText: (t: string) => ({
          width: advance(t),
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

function round(value: number) {
  return Math.round(value * 1000) / 1000;
}

function roundAll<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, v) => (typeof v === "number" ? round(v) : v)),
  );
}

const FIXTURES: Record<string, { source: string; prevType?: string }> = {
  "plain paragraph": { source: "hello world, this is a wrapped line of text" },
  "bold and italic": { source: "one **two three** four *five* six" },
  "arabic paragraph": { source: "مرحبا بالعالم هذا نص عربي طويل" },
  "arabic with english inside": {
    source: "مرحبا hello world بالعالم نص",
  },
  "english with arabic inside": {
    source: "hello مرحبا بالعالم world text",
  },
  "mostly english with one arabic word": {
    source: "hello there مرحبا and some more english words",
  },
  "emoji and combining marks": { source: "a👍b 👨‍👩‍👧 é 🇸🇦 end" },
  "heading below a paragraph": {
    source: "# A heading that wraps",
    prevType: "paragraph",
  },
  "bullet list item": { source: "- a list item that wraps around" },
  "nested numbered item": { source: "1. top\n   1. nested item text here" },
  "arabic list item": { source: "- عنصر قائمة طويل هنا" },
  quote: { source: "> quoted text that wraps too" },
  "inline math": { source: "sum $a+b+c+d+e+f+g+h$ tail" },
  "inline math in arabic": { source: "مرحبا $x^2$ بالعالم" },
  "display math": { source: "$$\na+b\n$$" },
  "empty paragraph": { source: "" },
};

const WIDTHS = [2000, 150];

describe("recorded text geometry", () => {
  const styles = resolveTheme({});
  const marks = createMathTestMarkRegistry();
  const nodes = createMathTestNodeRegistry();

  for (const [name, fixture] of Object.entries(FIXTURES)) {
    for (const width of WIDTHS) {
      it(`${name} at ${width}px`, () => {
        const page = loadMathPage(fixture.source);
        // The last block, so a nested item is the one measured.
        const loaded = page.blocks[page.blocks.length - 1] as TextualBlock;
        const block = fixture.prevType
          ? ({ ...loaded, prevType: fixture.prevType } as TextualBlock)
          : loaded;
        const node = nodes.get(block.type);
        if (!(node instanceof TextNode)) throw new Error(block.type);
        const layout = node.computeLayout(
          block,
          width,
          styles,
          undefined,
          marks,
        );
        const length = getVisibleTextFromRuns(block.charRuns).length;
        const originX = 30;
        const top = 7;
        const blockIndex = 1;

        const summary = {
          type: block.type,
          height: layout.height,
          insetY: layout.insetY,
          isRTL: layout.isRTL,
          indentOffset: layout.indentOffset,
          markerWidth: layout.markerWidth,
          lines: layout.lines.map((line) => ({ ...line })),
        };

        const carets = Array.from({ length: length + 1 }, (_, index) =>
          node.caretRect(layout, index, originX, top),
        );

        const points: [number, number, number][] = [];
        const ys = [top - 5];
        for (const line of layout.lines) {
          ys.push(top + layout.insetY + line.y + 1);
          ys.push(top + layout.insetY + line.y + line.height / 2);
        }
        ys.push(top + layout.height + 5);
        for (const y of ys) {
          for (let x = originX - 20; x <= originX + width + 20;) {
            points.push([
              x,
              y,
              node.positionFromPoint(block, layout, x, y, originX, top),
            ]);
            x += width > 1000 ? 23 : 4;
          }
        }

        const words = points.map(([x, y]) =>
          node.wordRangeFromPoint(layout, x, y, originX, top),
        );

        const selections: unknown[] = [];
        const at = (textIndex: number, index = blockIndex) => ({
          blockIndex: index,
          textIndex,
        });
        for (let from = 0; from <= length; from += 4) {
          for (let to = from; to <= length; to += 5) {
            for (const [continuous, hitTest] of [
              [false, false],
              [true, false],
              [true, true],
            ]) {
              selections.push([
                from,
                to,
                continuous,
                hitTest,
                node.selectionRects(
                  layout,
                  { anchor: at(from), focus: at(to), isForward: true },
                  blockIndex,
                  originX,
                  top,
                  continuous,
                  hitTest,
                ),
              ]);
            }
          }
        }
        // Selections that start or end in a neighbouring block.
        for (const index of [0, Math.floor(length / 2), length]) {
          for (const continuous of [false, true]) {
            selections.push([
              "from above",
              index,
              continuous,
              node.selectionRects(
                layout,
                { anchor: at(0, 0), focus: at(index), isForward: true },
                blockIndex,
                originX,
                top,
                continuous,
              ),
            ]);
            selections.push([
              "to below",
              index,
              continuous,
              node.selectionRects(
                layout,
                { anchor: at(index), focus: at(0, 2), isForward: true },
                blockIndex,
                originX,
                top,
                continuous,
              ),
            ]);
          }
        }

        expect(
          roundAll({ summary, carets, points, words, selections }),
        ).toMatchSnapshot();
      });
    }
  }
});

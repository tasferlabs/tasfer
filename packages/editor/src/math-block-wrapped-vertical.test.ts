/**
 * Vertical caret navigation out of a block equation whose LaTeX is long enough
 * to *text-wrap*. A `$$…$$` block is textual — its char-run text IS the LaTeX —
 * so TextNode's layout would break that raw string into several wrapped text
 * lines. Those lines have nothing to do with the equation's painted math rows
 * (a fraction's halves, a wrapped display line, a script slot): the math rows
 * are navigated by the tex caret model via `caretVerticalStep`, and only once it
 * reports no row beyond the edge should ArrowDown/ArrowUp leave the block.
 *
 * The bug this guards against: MathNode used to inherit TextNode's text-wrapped
 * `lines`, so after the math rows were exhausted the generic line-nav
 * fall-through stepped between those bogus lines and trapped the caret inside the
 * equation — you "couldn't arrow down anymore" out of a two-line formula.
 * MathNode now reports a single logical line spanning the whole equation, so the
 * fall-through recognises the block edge and exits.
 *
 * The node test-env stubs `measureText` to a constant width (nothing ever
 * wraps), so this file installs a length-proportional stub — created before the
 * first layout, since the measurement canvas is lazily built — to force real
 * text wrapping and exercise the path.
 */
import { createMathTestState, loadMathPage } from "./__testutils__/math";
import { moveCursorDown } from "./selection";
import type { CursorState, EditorState, ViewportState } from "./state-types";
import { getEditorStyles } from "./styles";
import { getVisibleTextFromRuns } from "./sync/char-runs";
import { beforeAll, describe, expect, it } from "vitest";

// A long equation that text-wraps at the width below but paints as a display
// formula with a subscript — the shape from the reported bug.
const LATEX =
  "output = activation_{function}((weights * inputs) + bias)" +
  "output = activation_{function}((weights * inputs) + bias)";

const VIEWPORT: ViewportState = {
  scrollY: 0,
  width: 700,
  height: 800,
  documentHeight: 3000,
};

beforeAll(() => {
  // Length-proportional text measurement so the raw LaTeX wraps as text (the
  // shared measurement canvas is created lazily on first layout, so overriding
  // createElement here — before any layout — reaches it).
  const g = globalThis as unknown as {
    document: { createElement: () => unknown };
  };
  const ctx = {
    measureText: (t: string) => ({
      width: (t?.length ?? 0) * 9,
      fontBoundingBoxAscent: 12,
      fontBoundingBoxDescent: 4,
    }),
    setTransform() {},
    save() {},
    restore() {},
    fillText() {},
    beginPath() {},
    roundRect() {},
    fill() {},
    fillRect() {},
  };
  g.document.createElement = () => ({
    getContext: () => ctx,
    style: {},
    setAttribute() {},
    appendChild() {},
    width: 1,
    height: 1,
  });
});

function layoutBlock(
  s: EditorState,
  blockIndex: number,
): { lines: readonly { startIndex: number; endIndex: number }[] } {
  const block = s.document.page.blocks[blockIndex];
  const node = s.nodes.get(block.type)!;
  const styles = getEditorStyles(s);
  const maxWidth =
    VIEWPORT.width - (styles.canvas.paddingLeft + styles.canvas.paddingRight);
  return node.layout({
    block,
    blockIndex,
    maxWidth,
    isFirst: false,
    styles,
    marks: s.marks,
  }) as { lines: readonly { startIndex: number; endIndex: number }[] };
}

function at(s: EditorState, textIndex: number): EditorState {
  const cursor: CursorState = {
    position: { blockIndex: 0, textIndex },
    lastUpdate: 0,
  };
  return { ...s, document: { ...s.document, cursor } };
}

describe("block math — vertical navigation out of a text-wrapping equation", () => {
  it("the same text wraps as a paragraph but the equation stays one logical line", () => {
    const para = createMathTestState(loadMathPage(LATEX));
    expect(para.document.page.blocks[0].type).toBe("paragraph");
    // Sanity: at this width the plain text genuinely wraps into several lines…
    expect(layoutBlock(para, 0).lines.length).toBeGreaterThan(1);

    const math = createMathTestState(loadMathPage(`$$${LATEX}$$`));
    expect(math.document.page.blocks[0].type).toBe("math");
    expect(getVisibleTextFromRuns(math.document.page.blocks[0].charRuns)).toBe(
      LATEX,
    );
    // …but the equation collapses to a single line spanning the whole LaTeX, so
    // the caret stack treats its internal rows as math geometry, not text lines.
    const mathLines = layoutBlock(math, 0).lines;
    expect(mathLines.length).toBe(1);
    expect(mathLines[0].startIndex).toBe(0);
    expect(mathLines[0].endIndex).toBe(LATEX.length);
  });

  it("ArrowDown from anywhere in the equation always escapes — never traps the caret", () => {
    const s = createMathTestState(loadMathPage(`$$${LATEX}$$\n\ntail`));
    const styles = getEditorStyles(s);
    // Populate the layout cache so caretVerticalStep reads the wrapped math rows.
    layoutBlock(s, 0);

    for (let start = 0; start <= LATEX.length; start++) {
      let cur = at(s, start);
      const seen = new Set<number>([start]);
      let escaped = false;
      for (let i = 0; i < 50; i++) {
        cur = moveCursorDown(cur, VIEWPORT, styles);
        const pos = cur.document.cursor!.position;
        if (pos.blockIndex !== 0) {
          escaped = true;
          break;
        }
        // Staying in the block must always make progress toward the edge; a
        // repeated offset would be the "stuck" bug.
        expect(seen.has(pos.textIndex)).toBe(false);
        seen.add(pos.textIndex);
      }
      expect(escaped, `stuck starting from offset ${start}`).toBe(true);
    }
  });
});

/**
 * @cypherkit/tex — canvas-native, live-editable LaTeX math engine.
 *
 * Pipeline: `latex → parse → layout → MathLayout`, then `paintMath` draws the
 * layout onto a canvas. `layoutMath` is synchronous and returns exact pixel
 * dimensions (metrics are a data table, not an async measurement).
 */
import { buildExpression } from "./layout/build.ts";
import type { Box } from "./layout/box.ts";
import type { Node } from "./parse/ast.ts";
import { parse } from "./parse/parser.ts";
import { DISPLAY, TEXT } from "./style.ts";

export interface LayoutOptions {
  /** Display style (centered, full-size operators) vs inline text style. */
  displayMode?: boolean;
  /** Pixel size of 1 em. Layout is computed in em then reported at this scale. */
  fontSize?: number;
  /**
   * Source range of a control word the caller is *still typing* — parsed as a
   * literal placeholder instead of being resolved, so the whole layout (paint
   * AND caret geometry derived from it) reflects the in-progress source text.
   * See {@link ParseOptions.literalRange} / `pendingCommandRange`.
   */
  literalRange?: { start: number; end: number };
}

export interface MathLayout {
  /** The laid-out box tree (dimensions in em; multiply by `fontSize` for px). */
  readonly box: Box;
  readonly fontSize: number;
  readonly displayMode: boolean;
  /** Total advance width in pixels. */
  readonly width: number;
  /** Extent above the baseline in pixels. */
  readonly height: number;
  /** Extent below the baseline in pixels. */
  readonly depth: number;
  /** Alias of `depth` — distance the box hangs below the text baseline. */
  readonly depthBelowBaseline: number;
}

/**
 * Whether `latex` parses with no unrecognized commands. The engine never throws
 * (it renders unknowns as placeholders), so this is the editor's "is this valid"
 * signal, not a crash guard.
 */
export function isValidLatex(latex: string): boolean {
  let ok = true;
  const visit = (n: Node): void => {
    if (n.type === "unknown") ok = false;
    else if (n.type === "ord" || n.type === "leftright") n.body.forEach(visit);
    else if (n.type === "supsub") {
      [n.base, n.sup, n.sub].forEach((c) => c && visit(c));
    } else if (n.type === "frac") {
      visit(n.num);
      visit(n.den);
    } else if (n.type === "sqrt") {
      visit(n.body);
      if (n.index) visit(n.index);
    } else if (n.type === "accent") visit(n.base);
    else if (n.type === "overunder") visit(n.body);
    else if (n.type === "mathfont") visit(n.body);
    else if (n.type === "not") visit(n.base);
    else if (n.type === "mclass" || n.type === "boxed" || n.type === "phantom") {
      visit(n.body);
    } else if (n.type === "stack") {
      visit(n.script);
      visit(n.base);
    } else if (n.type === "style") n.body.forEach(visit);
    else if (n.type === "array") {
      for (const row of n.rows) for (const cell of row) visit(cell);
    }
  };
  visit(parse(latex));
  return ok;
}

/** Parse and lay out `latex`. Never throws; invalid input renders partially. */
export function layoutMath(latex: string, opts: LayoutOptions = {}): MathLayout {
  const fontSize = opts.fontSize ?? 16;
  const displayMode = opts.displayMode ?? false;
  const ast = parse(latex, { literalRange: opts.literalRange });
  const box = buildExpression(
    ast.type === "ord" ? ast.body : [ast],
    displayMode ? DISPLAY : TEXT,
  );
  return {
    box,
    fontSize,
    displayMode,
    width: box.width * fontSize,
    height: box.height * fontSize,
    depth: box.depth * fontSize,
    depthBelowBaseline: box.depth * fontSize,
  };
}

export {
  parse,
  needsCommandSeparator,
  pendingCommandRange,
} from "./parse/parser.ts";
export type { ParseOptions } from "./parse/parser.ts";
export type { Node, Span } from "./parse/ast.ts";
export { paintMath, type PaintOptions } from "./paint/canvas.ts";
export { toSVG, type ToSvgOptions } from "./paint/svg.ts";
export {
  caretStops,
  hitTest,
  caretRect,
  caretVertical,
  selectionRects,
} from "./edit/caret.ts";
export type {
  CaretStop,
  CaretRect,
  SelectionRect,
} from "./edit/caret.ts";
export { unitBefore, unitAfter, type MathUnit } from "./edit/unit.ts";
export { fontFamily, loadFonts, ALL_VARIANTS } from "./fonts/fonts.ts";
export type { LoadFontsOptions } from "./fonts/fonts.ts";
export type {
  Box,
  GlyphBox,
  RuleBox,
  ListBox,
  PlaceholderBox,
} from "./layout/box.ts";
export type { FontVariant } from "./data/fontMetrics.ts";

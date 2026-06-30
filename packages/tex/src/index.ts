/**
 * @cypherkit/tex — canvas-native, live-editable LaTeX math engine.
 *
 * Pipeline: `latex → parse → layout → MathLayout`, then `paintMath` draws the
 * layout onto a canvas. `layoutMath` is synchronous and returns exact pixel
 * dimensions (metrics are a data table, not an async measurement).
 *
 * This module IS the curated public contract: it deals in `latex` strings and
 * the opaque `MathLayout` handle (which you create with `layoutMath` and hand
 * straight to `paintMath` / the caret helpers without inspecting). The brittle
 * internals it's built on — the laid-out box tree and the parse AST — live in
 * the explicitly-unstable `@cypherkit/tex/internal` entry (see ./internal.ts),
 * mirroring `@cypherkit/editor`. Keep this surface tight.
 */
import {
  buildExpression,
  buildExpressionWrapped,
  topLevelBreakOffsets,
} from "./layout/build";
import type { Box } from "./layout/box";
import type { Node } from "./parse/ast";
import { parse } from "./parse/parser";
import { DISPLAY, TEXT } from "./style";

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
  /**
   * Maximum width in pixels the formula may occupy. When set (and finite), the
   * top-level expression line-breaks to fit: it is split across rows at binary
   * operators and relations and stacked into one taller layout (its baseline
   * stays the first row's). A single unbreakable construct wider than this
   * overflows rather than breaking. Omit (the default) for the classic single
   * unbreakable row.
   */
  maxWidth?: number;
  /**
   * Width budget in pixels for the FIRST row only; defaults to `maxWidth`. Lets
   * an inline formula begin in the space left on a text line and use the full
   * width on continuation rows. Ignored unless `maxWidth` is set.
   */
  firstMaxWidth?: number;
  /** Pixels to indent continuation rows by. Ignored unless `maxWidth` is set. */
  wrapIndent?: number;
  /**
   * Extra leading in pixels between stacked rows. Defaults to a small gap.
   * Ignored unless `maxWidth` is set.
   */
  wrapLineGap?: number;
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
    else if (
      n.type === "mclass" ||
      n.type === "boxed" ||
      n.type === "phantom"
    ) {
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
export function layoutMath(
  latex: string,
  opts: LayoutOptions = {},
): MathLayout {
  const fontSize = opts.fontSize ?? 16;
  const displayMode = opts.displayMode ?? false;
  const ast = parse(latex, { literalRange: opts.literalRange });
  const nodes = ast.type === "ord" ? ast.body : [ast];
  const style = displayMode ? DISPLAY : TEXT;
  // Layout is computed in em; a px width budget converts at the current size.
  const box =
    opts.maxWidth != null && Number.isFinite(opts.maxWidth)
      ? buildExpressionWrapped(nodes, style, {
          maxWidth: opts.maxWidth / fontSize,
          firstMaxWidth:
            opts.firstMaxWidth != null
              ? opts.firstMaxWidth / fontSize
              : undefined,
          indent:
            opts.wrapIndent != null ? opts.wrapIndent / fontSize : undefined,
          lineGap:
            opts.wrapLineGap != null ? opts.wrapLineGap / fontSize : undefined,
        })
      : buildExpression(nodes, style);
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

/**
 * Source offsets where `latex` may be line-broken at top level — before each
 * binary operator / relation. Empty when the formula has no such break (a single
 * atom, one big construct). A caller wrapping inline math into running text uses
 * these as the only legal split points; the rendered width of each resulting
 * piece is `layoutMath(piece).width` (re-laid-out standalone), so this carries no
 * widths itself — just the break *structure*.
 */
export function breakpoints(latex: string): number[] {
  const ast = parse(latex);
  return topLevelBreakOffsets(ast.type === "ord" ? ast.body : [ast], TEXT);
}

export { needsCommandSeparator, pendingCommandRange } from "./parse/parser";
export { paintMath, type PaintOptions } from "./paint/canvas";
export { toSVG, type ToSvgOptions } from "./paint/svg";
export {
  caretStops,
  hitTest,
  caretRect,
  caretVertical,
  selectionRects,
} from "./edit/caret";
export type {
  CaretStop,
  CaretRect,
  HitTestOptions,
  SelectionRect,
} from "./edit/caret";
export {
  unitBefore,
  unitAfter,
  unitAt,
  isInsideConstruct,
  type MathUnit,
} from "./edit/unit";
export {
  normalizeLatex,
  isRedundantSpace,
  type LatexNormalization,
  type LatexInsert,
} from "./edit/normalize";
export { canRenderMathChar } from "./edit/char";
export { fontFamily, loadFonts, ALL_VARIANTS } from "./fonts/fonts";
export type { LoadFontsOptions } from "./fonts/fonts";
export type { FontVariant } from "./data/fontMetrics";

// The laid-out box tree (`Box`/`GlyphBox`/`RuleBox`/`ListBox`/`PlaceholderBox`),
// the parse AST (`Node`/`Span`), and `parse`/`ParseOptions` are brittle engine
// internals, not a stable contract — they live in `@cypherkit/tex/internal`.
// At the root, the box tree is reachable only as the opaque `MathLayout.box`.

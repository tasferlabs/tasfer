/**
 * @tasfer/tex — canvas-native, live-editable LaTeX math engine.
 *
 * Pipeline: `latex → parse → layout → MathLayout`, then `paintMath` draws the
 * layout onto a canvas. `layoutMath` is synchronous and returns exact pixel
 * dimensions (metrics are a data table, not an async measurement).
 *
 * This module IS the curated public contract: it deals in `latex` strings, the
 * stable identity-bearing `MathDocument`, the opaque `MathLayout` handle, and
 * identity-keyed `MathDocumentLayout` geometry. The brittle internals they're
 * built on — the laid-out box tree and rendering parse AST — live in the
 * explicitly-unstable `@tasfer/tex/internal` entry (see ./internal.ts),
 * mirroring `@tasfer/editor`. Keep this surface tight.
 */
import {
  createMathDocumentLayout,
  type MathDocumentFieldPosition,
  type MathDocumentLayout,
} from "./document/layout";
import type { MathDocument } from "./document/model";
import {
  type MathDocumentSourceProjection,
  projectMathDocumentSource,
} from "./document/print";
import type { Box } from "./layout/box";
import {
  annotateTextFallback,
  buildExpression,
  buildExpressionWrapped,
  topLevelBreakOffsets,
} from "./layout/build";
import type { Node, TextFallbackChar } from "./parse/ast";
import { parse, pendingCommandRange } from "./parse/parser";
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
   * Source offsets of `\`s that are editable field content rather than syntax,
   * independent of the caret. Supplied by the structured-document projection
   * (`layoutMathDocument` passes them automatically); see
   * {@link ParseOptions.literalBackslashes}.
   */
  literalBackslashes?: readonly number[];
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
  /**
   * Host font for characters inside `\text{…}` that the math fonts can't render
   * (CJK, emoji, …). When supplied, such a char is measured with `measure` and
   * typeset from `fontFamily` at paint time, instead of laying out as the
   * invisible zero-width fallback glyph (so `\text{中文}` shows the actual
   * characters). Omit (the default) to keep the engine glyph-metric-only —
   * unrenderable chars then stay invisible, as before. Latin text is unaffected
   * either way (it has native KaTeX glyphs).
   */
  textFallback?: TextFallback;
}

/** Source-offset-free options for the identity-bearing document layout API. */
export type MathDocumentLayoutOptions = Omit<
  LayoutOptions,
  "literalRange" | "literalBackslashes"
> & {
  /**
   * Stable field position of the caret while the user is typing INSIDE an
   * editable text field — the identity-keyed equivalent of
   * {@link LayoutOptions.literalRange}. When the caret sits at the trailing
   * edge of a `\`+letters run that is still pending (see
   * `pendingCommandRange`), that run is laid out as its literal source text
   * (`\pm` while heading to `\pmatrix`) instead of resolving to its symbol
   * (±). Uncommitted command scratch only ever lives in a raw-text field, so a
   * caret anywhere else (or a committed semantic node) never goes literal.
   * Callers can't express this as source offsets — the canonical projection is
   * internal — hence the stable address.
   */
  literalCaret?: Pick<MathDocumentFieldPosition, "nodeId" | "field" | "offset">;
};

/**
 * A host-provided text face for the `\text{…}` fallback (see
 * {@link LayoutOptions.textFallback}). `measure` returns em metrics (at size 1)
 * for a single character — the host reads them off a canvas (e.g. `measureText`
 * at a reference size, divided back to em). `fontFamily` is the CSS family the
 * same characters are painted with, so measurement and paint agree.
 */
export interface TextFallback {
  readonly fontFamily: string;
  readonly measure: (text: string) => TextFallbackChar;
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
  const ast = parse(latex, {
    literalRange: opts.literalRange,
    literalBackslashes: opts.literalBackslashes,
  });
  const nodes = ast.type === "ord" ? ast.body : [ast];
  // Measure any `\text{…}` characters the math fonts can't render (CJK, …) from
  // the host font, so they lay out at their true width instead of collapsing to
  // the invisible zero-width glyph. No-op without a `textFallback`.
  if (opts.textFallback) {
    annotateTextFallback(
      nodes,
      opts.textFallback.fontFamily,
      opts.textFallback.measure,
    );
  }
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
 * Lay out an authoritative identity-bearing math tree.
 *
 * The current painter still consumes the mature source-span layout engine, so
 * this function makes a transient canonical projection and immediately maps
 * its boxes/carets back to stable document ids. The source is never returned as
 * editable state: callers mutate `document`, then lay it out again.
 */
export function layoutMathDocument(
  document: MathDocument,
  opts: MathDocumentLayoutOptions = {},
): MathDocumentLayout {
  const projection = projectMathDocumentSource(document);
  const { literalCaret, ...layoutOpts } = opts;
  const literalRange = literalCaret
    ? (projectedPendingCommandRange(projection, literalCaret) ?? undefined)
    : undefined;
  return createMathDocumentLayout(
    projection,
    layoutMath(projection.latex, {
      ...layoutOpts,
      literalRange,
      literalBackslashes: projection.literalBackslashes,
    }),
  );
}

/**
 * The projected-source range of the command still being typed at `caret`, or
 * null. Field anchors exist at every character boundary of an editable field,
 * so the caret's stable address resolves to one exact source offset; the
 * pending-vs-resolved decision is then `pendingCommandRange`'s, identical to
 * the source-offset API.
 */
function projectedPendingCommandRange(
  projection: MathDocumentSourceProjection,
  caret: Pick<MathDocumentFieldPosition, "nodeId" | "field" | "offset">,
): { start: number; end: number } | null {
  const anchor = projection.anchors.find(
    (candidate) =>
      candidate.kind === "field" &&
      candidate.nodeId === caret.nodeId &&
      candidate.field === caret.field &&
      candidate.offset === caret.offset,
  );
  if (!anchor) return null;
  return pendingCommandRange(projection.latex, anchor.sourceOffset);
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

export type { FontVariant } from "./data/fontMetrics";
export {
  hitTestMathDocument,
  type MathDocumentBounds,
  type MathDocumentCaretAddress,
  mathDocumentCaretFromSourceOffset,
  type MathDocumentCaretPosition,
  type MathDocumentCaretStop,
  mathDocumentCaretStop,
  mathDocumentCaretVertical,
  type MathDocumentFieldPosition,
  type MathDocumentHitTestOptions,
  type MathDocumentItemLayout,
  type MathDocumentItemType,
  type MathDocumentLayout,
  type MathDocumentRowPosition,
} from "./document/layout";
export {
  backslashFusesWith,
  balanceBraces,
  escapeStrayCloseBraces,
  escapeTypedBrace,
  escapeTypedReserved,
  inRawTextArg,
  strayCloseBraceInserts,
} from "./edit/brace";
export type {
  CaretRect,
  CaretStop,
  HitTestOptions,
  SelectionRect,
  SpanAtPointOptions,
} from "./edit/caret";
export {
  caretRect,
  caretStops,
  caretVertical,
  hitTest,
  selectionRects,
  spanAtPoint,
} from "./edit/caret";
export { canRenderMathChar } from "./edit/char";
export {
  type MatrixContext,
  matrixContextAt,
  matrixContextInRange,
  type MatrixEditResult,
  matrixResize,
  type MatrixTextEdit,
} from "./edit/matrix";
export {
  isRedundantSpace,
  type LatexInsert,
  type LatexNormalization,
  normalizeLatex,
} from "./edit/normalize";
export {
  isInsideConstruct,
  type MathUnit,
  resolveSelectionRange,
  scriptAttachOffset,
  unitAfter,
  unitAt,
  unitBefore,
} from "./edit/unit";
export type { LoadFontsOptions } from "./fonts/fonts";
export { ALL_VARIANTS, fontFamily, loadFonts } from "./fonts/fonts";
export { paintMath, type PaintOptions } from "./paint/canvas";
export { toSVG, type ToSvgOptions } from "./paint/svg";
export type { TextFallbackChar } from "./parse/ast";
export { needsCommandSeparator, pendingCommandRange } from "./parse/parser";
export {
  type OperatorCommand,
  operatorCommands,
  type SymbolCommand,
  symbolCommands,
} from "./vocabulary";

// Stable structured-editing model. Unlike the rendering AST, these values have
// persistent ids and are safe for hosts to store, edit, and expose publicly.
export {
  type AllocatedIdentity,
  createDeterministicIdentityAllocator,
  type IdentityAllocator,
  type MathDelimited,
  type MathDocument,
  mathDocumentsSemanticallyEqual,
  type MathFraction,
  type MathItemId,
  type MathMatrix,
  type MathMatrixCell,
  type MathMatrixRow,
  type MathNode,
  type MathOperator,
  type MathRadical,
  type MathRawLatex,
  type MathRawText,
  type MathRoot,
  type MathRow,
  type MathScripts,
  type MathSymbol,
  type MathSymbolClass,
  type MathText,
  type MathTextVariant,
  parseAllocatedIdentity,
  parseMathDocument,
  type ParseMathDocumentOptions,
  printMathDocument,
  printMathRow,
} from "./document/index";

// The laid-out box tree (`Box`/`GlyphBox`/`RuleBox`/`ListBox`/`PlaceholderBox`),
// the parse AST (`Node`/`Span`), and `parse`/`ParseOptions` are brittle engine
// internals, not a stable contract — they live in `@tasfer/tex/internal`.
// At the root, the box tree is reachable only as the opaque `MathLayout.box`.

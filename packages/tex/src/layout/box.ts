/**
 * The layout box model. A laid-out formula is a tree of boxes, each with a
 * `width`, a `height` (extent above the baseline) and a `depth` (extent below).
 * All dimensions are in absolute root em (the size multiplier is already baked
 * in), so a parent never has to rescale a child — it just places it.
 *
 * Coordinate convention: a box's own baseline is its local origin; +y points
 * DOWN (canvas-friendly). A child is positioned by `(dx, dy)` where `dy` shifts
 * its baseline below the parent baseline (negative = up, as for a superscript).
 */
import type { AtomClass } from "../data/constants.ts";
import {
  type FontVariant,
  getCharacterMetrics,
} from "../data/fontMetrics.ts";
import type { Span } from "../parse/ast.ts";

export interface Dim {
  width: number;
  height: number;
  depth: number;
}

/** A single drawn glyph. */
export interface GlyphBox extends Dim {
  readonly type: "glyph";
  readonly char: string;
  readonly variant: FontVariant;
  /** Font size in em this glyph is drawn at (root-absolute). */
  readonly size: number;
  readonly italic: number;
  /** Kern to the skewchar — used to center an accent over the glyph. */
  readonly skew: number;
  readonly span: Span | null;
  /** Override paint color (e.g. red for unknown-command placeholders). */
  readonly color?: string;
  /** Vertical scale applied at paint time (extensible delimiter pieces). */
  readonly yScale?: number;
}

/**
 * A glyph box with its metrics scaled vertically by `yScale` — the canvas-native
 * way to build the extensible middle of a tall delimiter (KaTeX stretches an
 * SVG; we just scale the repeat glyph).
 */
export function scaledGlyph(base: GlyphBox, yScale: number): GlyphBox {
  return {
    ...base,
    yScale,
    height: base.height * yScale,
    depth: base.depth * yScale,
  };
}

/** A filled rectangle (fraction bar, radical vinculum, …). */
export interface RuleBox extends Dim {
  readonly type: "rule";
}

/** A move/line path command in em coordinates relative to the box origin. */
export type PathCmd = ["M" | "L", number, number];

/**
 * A stroked or filled vector path (em coordinates, +y down). Used for shapes
 * the fonts don't supply as a single glyph — the radical surd, stretchy arrows
 * — drawn straight onto the canvas (a structural advantage of the backend).
 */
export interface PathBox extends Dim {
  readonly type: "path";
  readonly commands: PathCmd[];
  /** Stroke width in em; if omitted the path is filled instead. */
  readonly strokeWidth?: number;
}

export interface Placed {
  readonly box: Box;
  readonly dx: number;
  readonly dy: number;
}

/** A composite: children placed at explicit offsets from this box's origin. */
export interface ListBox extends Dim {
  readonly type: "list";
  readonly children: Placed[];
  klass?: AtomClass;
  span?: Span | null;
}

export type Box = GlyphBox | RuleBox | PathBox | ListBox;

/** A glyph box for `char` in `variant`, drawn at `size` em (root-absolute). */
export function glyphBox(
  char: string,
  variant: FontVariant,
  size: number,
  span: Span | null,
  color?: string,
): GlyphBox {
  const m = getCharacterMetrics(char, variant, size);
  if (!m) {
    return {
      type: "glyph",
      char,
      variant,
      size,
      italic: 0,
      skew: 0,
      span,
      color,
      width: 0,
      height: 0,
      depth: 0,
    };
  }
  return {
    type: "glyph",
    char,
    variant,
    size,
    italic: m.italic,
    skew: m.skew,
    span,
    color,
    width: m.width,
    height: m.height,
    depth: m.depth,
  };
}

export function ruleBox(width: number, height: number, depth = 0): RuleBox {
  return { type: "rule", width, height, depth };
}

export function pathBox(
  commands: PathCmd[],
  dim: Dim,
  strokeWidth?: number,
): PathBox {
  return { type: "path", commands, strokeWidth, ...dim };
}

/** Compose placed children into a list box, deriving its dimensions. */
export function listBox(
  children: Placed[],
  opts: { width?: number; klass?: AtomClass; span?: Span | null } = {},
): ListBox {
  let height = 0;
  let depth = 0;
  let right = 0;
  for (const { box, dx, dy } of children) {
    height = Math.max(height, box.height - dy);
    depth = Math.max(depth, box.depth + dy);
    right = Math.max(right, dx + box.width);
  }
  return {
    type: "list",
    children,
    width: opts.width ?? right,
    height,
    depth,
    klass: opts.klass,
    span: opts.span,
  };
}

export type HItem = Box | { kern: number };

/** Lay boxes (and kerns) out left-to-right on a shared baseline. */
export function hbox(
  items: HItem[],
  opts: { klass?: AtomClass; span?: Span | null } = {},
): ListBox {
  const children: Placed[] = [];
  let x = 0;
  for (const item of items) {
    if ("kern" in item) {
      x += item.kern;
    } else {
      children.push({ box: item, dx: x, dy: 0 });
      x += item.width;
    }
  }
  return listBox(children, { width: x, klass: opts.klass, span: opts.span });
}

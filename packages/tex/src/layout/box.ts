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

/**
 * An empty editable slot — the numerator of `\frac{}{b}`, the script of `x^{}`,
 * a blank matrix cell. Drawn as a faint box (so the user sees a target) and,
 * crucially, it carries the source `offset` *inside* the empty braces so the
 * caret can land and type there (an empty group otherwise lays out to nothing,
 * leaving the slot invisible and unreachable). Live-editing only — well-formed
 * read-only math has no empty groups.
 */
export interface PlaceholderBox extends Dim {
  readonly type: "placeholder";
  /** Source offset the caret sits at (between the empty group's braces). */
  readonly offset: number;
}

/**
 * The slot a placed child occupies within a multi-part construct, when that
 * matters for caret navigation. Only super/subscripts are tagged: they stack
 * vertically at the same column AS the base sits between them on the baseline,
 * so pure geometry would step ↓ from a superscript onto the base rather than
 * across to the subscript. The tag lets {@link caretVertical} connect the two
 * script slots structurally (a fraction needs no tag — nothing sits on the
 * baseline between its halves, so geometry already links them).
 */
export type SlotRole = "sup" | "sub";

export interface Placed {
  readonly box: Box;
  readonly dx: number;
  readonly dy: number;
  /** Which script slot of the enclosing construct this child is, if any. */
  readonly role?: SlotRole;
}

/** A composite: children placed at explicit offsets from this box's origin. */
export interface ListBox extends Dim {
  readonly type: "list";
  readonly children: Placed[];
  klass?: AtomClass;
  span?: Span | null;
  /**
   * When set, this box is a multi-part construct (fraction, root, script, …)
   * whose inner caret stops sit on their own rows — so it also contributes caret
   * stops at its OUTER left/right edges on the parent baseline. Those are the
   * top-level positions beside the construct: the caret can sit just before/after
   * a `\frac` (and step out of it) even when nothing else follows on the line.
   */
  boundary?: boolean;
  /**
   * Italic correction carried from a single wrapped symbol (a big-operator
   * glyph) so a following sub/superscript can offset by it exactly as it would
   * for a bare glyph base — the op glyph is wrapped in a list (to shift it onto
   * the axis), which would otherwise hide its italic from Rule 18.
   */
  italic?: number;
}

export type Box = GlyphBox | RuleBox | PathBox | ListBox | PlaceholderBox;

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

/** A faint, caret-landable box for an empty slot at source `offset`. */
export function placeholderBox(offset: number, dim: Dim): PlaceholderBox {
  return { type: "placeholder", offset, ...dim };
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
  opts: {
    width?: number;
    klass?: AtomClass;
    span?: Span | null;
    italic?: number;
  } = {},
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
    italic: opts.italic,
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

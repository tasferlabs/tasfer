/**
 * The live-edit layer: map between screen coordinates and source offsets over a
 * laid-out formula. This is what lets a caret live *inside* the rendered math —
 * the payoff of carrying a source `span` on every box (parse → layout → here).
 *
 * The model is a flat, sorted list of caret stops: each glyph contributes a
 * stop at its left edge (its span start) and right edge (its span end), with the
 * screen geometry needed to draw a caret or hit-test a click. Structural nodes
 * (fractions, scripts, radicals) need no special handling — their inner glyphs
 * already carry spans, so the caret naturally descends into them.
 */
import type { Box } from "../layout/box.ts";
import type { MathLayout } from "../index.ts";

export interface CaretStop {
  /** Offset into the source LaTeX string. */
  readonly offset: number;
  /** Horizontal position in pixels (from the layout origin). */
  readonly x: number;
  /** Top of the caret in pixels (negative = above baseline). */
  readonly top: number;
  /** Bottom of the caret in pixels. */
  readonly bottom: number;
}

export interface CaretRect {
  readonly x: number;
  readonly top: number;
  readonly bottom: number;
}

export interface SelectionRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Every caret stop for a layout, sorted by source offset then x. Glyphs with no
 * source span (e.g. delimiter pieces) are skipped — the caret only stops at real
 * source positions.
 */
export function caretStops(layout: MathLayout): CaretStop[] {
  const stops: CaretStop[] = [];
  const fs = layout.fontSize;
  walk(layout.box, 0, 0, fs, stops);
  stops.sort((a, b) => a.offset - b.offset || a.x - b.x);
  // De-duplicate coincident stops (same offset and x).
  const out: CaretStop[] = [];
  for (const s of stops) {
    const prev = out[out.length - 1];
    if (prev && prev.offset === s.offset && Math.abs(prev.x - s.x) < 0.01) {
      continue;
    }
    out.push(s);
  }
  return out;
}

function walk(box: Box, x: number, y: number, fs: number, out: CaretStop[]): void {
  if (box.type === "glyph") {
    if (box.span && box.width > 0) {
      const top = y - box.height * fs;
      const bottom = y + box.depth * fs;
      out.push({ offset: box.span.start, x, top, bottom });
      out.push({ offset: box.span.end, x: x + box.width * fs, top, bottom });
    }
    return;
  }
  if (box.type === "list") {
    for (const child of box.children) {
      walk(child.box, x + child.dx * fs, y + child.dy * fs, fs, out);
    }
  }
  // rule / path boxes carry no source position.
}

/**
 * Source offset nearest to a click at `(x, y)`. Prefers stops whose vertical
 * band contains `y` (so a click in a numerator lands in the numerator), then
 * falls back to the horizontally-closest stop overall.
 */
export function hitTest(layout: MathLayout, x: number, y: number): number {
  const stops = caretStops(layout);
  if (stops.length === 0) return 0;

  let best: CaretStop | null = null;
  let bestDist = Infinity;
  let bestInBand: CaretStop | null = null;
  let bestBandDist = Infinity;

  for (const s of stops) {
    const dist = Math.abs(s.x - x);
    if (dist < bestDist) {
      bestDist = dist;
      best = s;
    }
    if (y >= s.top && y <= s.bottom && dist < bestBandDist) {
      bestBandDist = dist;
      bestInBand = s;
    }
  }
  return (bestInBand ?? best!).offset;
}

/** Caret geometry for a source `offset`, or null if the layout has no stops. */
export function caretRect(layout: MathLayout, offset: number): CaretRect | null {
  const stops = caretStops(layout);
  if (stops.length === 0) return null;
  let best = stops[0];
  let bestDist = Math.abs(stops[0].offset - offset);
  for (const s of stops) {
    const d = Math.abs(s.offset - offset);
    if (d < bestDist) {
      bestDist = d;
      best = s;
    }
  }
  return { x: best.x, top: best.top, bottom: best.bottom };
}

/**
 * Highlight rectangles covering the source range `[start, end)`. Returns one
 * rect per contiguous run of selected glyphs (typically one for inline math).
 */
export function selectionRects(
  layout: MathLayout,
  start: number,
  end: number,
): SelectionRect[] {
  if (end < start) [start, end] = [end, start];
  const fs = layout.fontSize;
  const segs: { x0: number; x1: number; top: number; bottom: number }[] = [];
  collectSelected(layout.box, 0, 0, fs, start, end, segs);
  // Merge into a single bounding rect (inline math is one line).
  if (segs.length === 0) return [];
  let x0 = Infinity,
    x1 = -Infinity,
    top = Infinity,
    bottom = -Infinity;
  for (const s of segs) {
    x0 = Math.min(x0, s.x0);
    x1 = Math.max(x1, s.x1);
    top = Math.min(top, s.top);
    bottom = Math.max(bottom, s.bottom);
  }
  return [{ x: x0, y: top, width: x1 - x0, height: bottom - top }];
}

function collectSelected(
  box: Box,
  x: number,
  y: number,
  fs: number,
  start: number,
  end: number,
  out: { x0: number; x1: number; top: number; bottom: number }[],
): void {
  if (box.type === "glyph") {
    if (box.span && box.span.start >= start && box.span.end <= end) {
      out.push({
        x0: x,
        x1: x + box.width * fs,
        top: y - box.height * fs,
        bottom: y + box.depth * fs,
      });
    }
    return;
  }
  if (box.type === "list") {
    for (const child of box.children) {
      collectSelected(
        child.box,
        x + child.dx * fs,
        y + child.dy * fs,
        fs,
        start,
        end,
        out,
      );
    }
  }
}

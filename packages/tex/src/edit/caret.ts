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
import type { Box, SlotRole } from "../layout/box";
import type { MathLayout } from "../index";

export interface CaretStop {
  /** Offset into the source LaTeX string. */
  readonly offset: number;
  /** Horizontal position in pixels (from the layout origin). */
  readonly x: number;
  /**
   * Baseline of the row this stop sits on, in pixels (0 = the formula baseline,
   * +down). Glyphs on the same text baseline share this exactly regardless of
   * their height/depth, so it — not the glyph mid-point — is the discriminator
   * for which *row* a stop belongs to (a superscript/numerator sits on a row
   * with a smaller `y`, a subscript/denominator a larger one). Used by
   * {@link caretVertical}.
   */
  readonly y: number;
  /** Top of the caret in pixels (negative = above baseline). */
  readonly top: number;
  /** Bottom of the caret in pixels. */
  readonly bottom: number;
  /**
   * True for a stop at a construct's OUTER edge on the parent baseline (see
   * {@link ListBox.boundary}). When a source offset is both a construct's edge
   * and an inner glyph's edge (e.g. the end of `x^{2}` is also the end of the
   * `2`), {@link caretRect} prefers this one so the caret sits beside the whole
   * construct on the main baseline rather than up on the script row.
   */
  readonly boundary?: boolean;
  /**
   * The script slot this stop sits in (`"sup"`/`"sub"`), and a per-construct id
   * shared by every stop of the SAME super/subscript construct. Set only for
   * stops inside a script — used by {@link caretVertical} to connect a
   * superscript directly to its subscript (↓/↑), stepping *over* the base that
   * sits between them on the baseline. Undefined everywhere else (the caret
   * navigates those by pure geometry).
   */
  readonly slot?: SlotRole;
  readonly construct?: number;
  /** Visual bounds of an empty editable slot, used to enlarge its hit target. */
  readonly placeholder?: {
    readonly left: number;
    readonly right: number;
  };
}

export interface HitTestOptions {
  /** Minimum width and height, in CSS pixels, of an empty-slot hit target. */
  readonly placeholderTargetSize?: number;
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
  walk(layout.box, 0, 0, fs, stops, { next: 0 });
  stops.sort((a, b) => a.offset - b.offset || a.x - b.x);
  // De-duplicate coincident stops (same offset and x). A construct's boundary
  // stop that lands exactly on an inner glyph's edge is dropped in favor of the
  // glyph (which carries the correct row height) — boundary stops are emitted
  // last, so the glyph already occupies `out`.
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

/**
 * The script slot the current box sits inside, threaded down the walk so a
 * stop deep in a superscript (`x^{a+b}` → both `a` and `b`) is still tagged with
 * the slot + construct id of that script. `gen` hands out fresh construct ids.
 */
interface SlotCtx {
  readonly slot?: SlotRole;
  readonly construct?: number;
}
interface ConstructGen {
  next: number;
}

function walk(
  box: Box,
  x: number,
  y: number,
  fs: number,
  out: CaretStop[],
  gen: ConstructGen,
  ctx: SlotCtx = {},
): void {
  if (box.type === "glyph") {
    if (box.span && box.width > 0) {
      const top = y - box.height * fs;
      const bottom = y + box.depth * fs;
      out.push({ offset: box.span.start, x, y, top, bottom, ...ctx });
      out.push({
        offset: box.span.end,
        x: x + box.width * fs,
        y,
        top,
        bottom,
        ...ctx,
      });
    }
    return;
  }
  if (box.type === "placeholder") {
    // A single stop centered in the empty slot, on that slot's own row.
    const top = y - box.height * fs;
    const bottom = y + box.depth * fs;
    out.push({
      offset: box.offset,
      x: x + (box.width * fs) / 2,
      y,
      top,
      bottom,
      placeholder: { left: x, right: x + box.width * fs },
      ...ctx,
    });
    return;
  }
  if (box.type === "list") {
    // A construct whose children carry script roles (a super/subscript) gets one
    // fresh id shared by its sup and sub, so caretVertical can pair them.
    const isScripted = box.children.some((c) => c.role);
    const construct = isScripted ? gen.next++ : ctx.construct;
    // Walk the inner glyphs (each on its own row) first…
    for (const child of box.children) {
      // A roled child opens a new slot; an unroled child inherits the slot it
      // sits in (so glyphs nested inside a script stay tagged).
      const childCtx: SlotCtx = child.role
        ? { slot: child.role, construct }
        : ctx;
      walk(
        child.box,
        x + child.dx * fs,
        y + child.dy * fs,
        fs,
        out,
        gen,
        childCtx,
      );
    }
    // …then add the construct's OUTER-edge stops on the parent baseline — the
    // top-level positions beside the whole construct, so the caret can sit just
    // before/after a `\frac` and step out of it even when nothing follows on the
    // line. They are flagged `boundary` so vertical motion ignores them (they are
    // not a row) and a coincident inner glyph stop wins de-duplication (keeping
    // its own height) — emitting them last makes the glyph stop sort first.
    if (box.boundary && box.span) {
      const top = y - box.height * fs;
      const bottom = y + box.depth * fs;
      out.push({ offset: box.span.start, x, y, top, bottom, boundary: true });
      out.push({
        offset: box.span.end,
        x: x + box.width * fs,
        y,
        top,
        bottom,
        boundary: true,
      });
    }
  }
  // rule / path boxes carry no source position.
}

/**
 * Source offset nearest to a click at `(x, y)`. Prefers stops whose vertical
 * band contains `y` (so a click in a numerator lands in the numerator), then
 * falls back to the horizontally-closest stop overall.
 */
export function hitTest(
  layout: MathLayout,
  x: number,
  y: number,
  options: HitTestOptions = {},
): number {
  const stops = caretStops(layout);
  if (stops.length === 0) return 0;

  let best: CaretStop | null = null;
  let bestDist = Infinity;
  let bestInBand: CaretStop | null = null;
  let bestBandDist = Infinity;
  let bestGlyphInBand: CaretStop | null = null;
  let bestGlyphBandDist = Infinity;
  let bestPlaceholder: CaretStop | null = null;
  let bestPlaceholderDist = Infinity;
  const placeholderTargetSize = options.placeholderTargetSize ?? 0;

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
    if (
      !s.placeholder &&
      !s.boundary &&
      y >= s.top &&
      y <= s.bottom &&
      dist < bestGlyphBandDist
    ) {
      bestGlyphBandDist = dist;
      bestGlyphInBand = s;
    }
    if (s.placeholder && placeholderTargetSize > 0) {
      const width = s.placeholder.right - s.placeholder.left;
      const height = s.bottom - s.top;
      const hitWidth = Math.max(width, placeholderTargetSize);
      const hitHeight = Math.max(height, placeholderTargetSize);
      const dx = Math.abs(x - s.x);
      const dy = Math.abs(y - (s.top + s.bottom) / 2);
      if (
        dx <= hitWidth / 2 &&
        dy <= hitHeight / 2 &&
        Math.hypot(dx, dy) < bestPlaceholderDist
      ) {
        bestPlaceholderDist = Math.hypot(dx, dy);
        bestPlaceholder = s;
      }
    }
  }

  // A directly-hit glyph/row still wins when it is closer than an overlapping
  // enlarged empty-slot target (important for tightly stacked fractions).
  if (
    bestPlaceholder &&
    (!bestGlyphInBand || bestPlaceholderDist < bestGlyphBandDist)
  ) {
    return bestPlaceholder.offset;
  }
  return (bestInBand ?? best!).offset;
}

/** Caret geometry for a source `offset`, or null if the layout has no stops. */
export function caretRect(
  layout: MathLayout,
  offset: number,
): CaretRect | null {
  const stops = caretStops(layout);
  if (stops.length === 0) return null;
  let best = stops[0];
  let bestDist = Math.abs(stops[0].offset - offset);
  for (const s of stops) {
    const d = Math.abs(s.offset - offset);
    // On an exact-offset tie prefer a construct boundary stop: at a construct's
    // right edge (e.g. the end of `x^{2}`, also the end of the `2`) the caret
    // should sit beside the whole construct on the main baseline, not up on the
    // script row.
    if (d < bestDist || (d === bestDist && d === 0 && s.boundary)) {
      bestDist = d;
      best = s;
    }
  }
  return { x: best.x, top: best.top, bottom: best.bottom };
}

/**
 * The caret stop nearest a source `offset`. On an exact-offset tie a construct
 * boundary stop wins — mirroring {@link caretRect}, so that a caret resting
 * *beside* a whole construct on the main baseline is treated as a baseline stop
 * (no script slot), not as sitting inside the script that happens to end there.
 */
function nearestStopByOffset(stops: CaretStop[], offset: number): CaretStop {
  let best = stops[0];
  let bestDist = Math.abs(stops[0].offset - offset);
  for (const s of stops) {
    const d = Math.abs(s.offset - offset);
    if (d < bestDist || (d === bestDist && d === 0 && s.boundary)) {
      bestDist = d;
      best = s;
    }
  }
  return best;
}

/**
 * Source offset one visual row up/down from `offset`, at horizontal position
 * `preferredX` (px from the layout origin) — the vertical caret motion *inside*
 * a formula (a fraction's numerator ↔ denominator, a base ↔ its superscript).
 * Returns null when there is no stop in that direction, so the caller can leave
 * the formula and fall back to normal line navigation.
 *
 * The target is the stop minimizing horizontal distance to `preferredX`, with
 * vertical distance only as a tiebreak (weight {@link VERTICAL_X_WEIGHT}). That
 * bias is what makes the caret land in the slot *directly* above/below — a
 * fraction stacks its halves vertically aligned, whereas a baseline sibling
 * (e.g. a `+` beside the fraction) sits off to the side and so loses on x even
 * though it is geometrically closer. Pure geometry, no structural tree needed.
 *
 * The ONE case geometry can't carry is a super/subscript: its two slots stack
 * vertically but the base sits between them on the baseline at the SAME column,
 * so ↓ from a superscript would land on the base. So before falling back to
 * geometry we take a structural shortcut — ↓ from a superscript (resp. ↑ from a
 * subscript) jumps straight to the paired subscript (resp. superscript) of the
 * same construct, choosing the stop nearest `preferredX` and, when that is
 * ambiguous, the FIRST (leftmost) term in the slot.
 */
export function caretVertical(
  layout: MathLayout,
  offset: number,
  dir: "up" | "down",
  preferredX: number,
): number | null {
  const stops = caretStops(layout);
  if (stops.length === 0) return null;

  const cur = nearestStopByOffset(stops, offset);

  // Structural jump between the two script slots of one construct, over the base.
  // (↓ leaves a superscript for its subscript; ↑ leaves a subscript for its sup.)
  if (cur.construct !== undefined) {
    const want: SlotRole | null =
      dir === "down" && cur.slot === "sup"
        ? "sub"
        : dir === "up" && cur.slot === "sub"
          ? "sup"
          : null;
    if (want) {
      let target: CaretStop | null = null;
      let targetDx = Infinity;
      for (const s of stops) {
        if (s.construct !== cur.construct || s.slot !== want) continue;
        const dx = Math.abs(s.x - preferredX);
        // Strict `<` keeps the FIRST (lowest-offset, leftmost) stop on a tie —
        // the "take the first term when ambiguous" rule.
        if (dx < targetDx) {
          targetDx = dx;
          target = s;
        }
      }
      if (target) return target.offset;
    }
  }

  const ROW_EPS = 0.5; // px — rows nearer than this count as the caret's own

  let best: CaretStop | null = null;
  let bestScore = Infinity;
  for (const s of stops) {
    // Construct boundary stops are top-level horizontal exit points, not a row
    // of their own — skip them so ↑/↓ reach the real slot above/below rather
    // than the main-baseline stop that sits between the two rows.
    if (s.boundary) continue;
    // Compare row baselines, not glyph mid-points: every baseline glyph shares
    // `y`, so tall/short letters on one line never look like separate rows.
    const dy = dir === "up" ? cur.y - s.y : s.y - cur.y;
    if (dy <= ROW_EPS) continue; // not strictly in the requested direction
    const score = Math.abs(s.x - preferredX) * VERTICAL_X_WEIGHT + dy;
    if (score < bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return best ? best.offset : null;
}

/** How much more horizontal distance counts than vertical in {@link caretVertical}. */
const VERTICAL_X_WEIGHT = 3;

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
    // A construct (a list box with a source span) that falls ENTIRELY within
    // the selection highlights as one solid rect — its own bounding box — so the
    // whole thing is covered, including empty slots, rules and delimiters that
    // are not glyph children (e.g. `\frac{}{b}` selected whole would otherwise
    // light up only the `b`). A partial overlap descends to highlight the glyphs.
    if (box.span && box.span.start >= start && box.span.end <= end) {
      out.push({
        x0: x,
        x1: x + box.width * fs,
        top: y - box.height * fs,
        bottom: y + box.depth * fs,
      });
      return;
    }
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

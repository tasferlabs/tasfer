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

/**
 * One place the caret can sit in a laid-out formula: its offset in the LaTeX
 * source and where that is on screen. {@link caretStops} lists them all.
 *
 * @group Caret and selection
 */
export interface CaretStop {
  /** Offset into the source LaTeX string. */
  readonly offset: number;
  /** Horizontal position in pixels (from the layout origin). */
  readonly x: number;
  /**
   * Baseline of this stop's row, in pixels from the formula baseline. Positive
   * is down. Every stop on one row has the same `y`, so use it to tell rows
   * apart. A superscript or numerator has a smaller `y`, and a subscript or
   * denominator a larger one. Used by {@link caretVertical}.
   */
  readonly y: number;
  /** Top of the caret in pixels (negative = above baseline). */
  readonly top: number;
  /** Bottom of the caret in pixels. */
  readonly bottom: number;
  /**
   * Top of the DRAWN caret, when it is shorter than the stop's `top`..`bottom`
   * band (e.g. just after an integral with scripts, where a full-height caret
   * would cut through the sign's overhang). Hit-testing keeps using `top`.
   */
  readonly caretTop?: number;
  /**
   * `true` for a stop at the outer edge of a construct, on the main line. One
   * offset can be both a construct's edge and a glyph's edge: the end of
   * `x^{2}` is also the end of the `2`. For a plain caret, {@link caretRect}
   * then picks the boundary stop, but only at the construct's trailing edge
   * (where `partnerX` is to its left). So the caret sits on the main line
   * beside a construct it just left, not up on the script.
   */
  readonly boundary?: boolean;
  /**
   * For a `boundary` stop, the x of the construct's OTHER outer edge. The pair
   * `(x, partnerX)` brackets the construct's horizontal extent, letting the
   * hit-test tell a click that fell *inside* a construct's body (e.g. on a √
   * sign's wide leading stroke) from one genuinely beside it. Set only on
   * boundary stops.
   */
  readonly partnerX?: number;
  /**
   * Which script slot this stop is in: `"sup"` or `"sub"`. Set only inside a
   * superscript or subscript. {@link caretVertical} uses it, with `construct`,
   * to jump straight between a superscript and its subscript, over the base
   * between them.
   */
  // Give `construct` (line 68) its own doc comment, e.g. "Id shared by every
  // stop of the same script construct. Set together with `slot`."
  readonly slot?: SlotRole;
  readonly construct?: number;
  /** Visual bounds of an empty editable slot, used to enlarge its hit target. */
  readonly placeholder?: {
    readonly left: number;
    readonly right: number;
  };
}

/**
 * Options for {@link hitTest}, which turns a click or touch point into a caret
 * position in the formula.
 *
 * @group Caret and selection
 */
export interface HitTestOptions {
  /** Minimum width and height, in CSS pixels, of an empty-slot hit target. */
  readonly placeholderTargetSize?: number;
  /**
   * Set this while a finger drags the caret, such as with the magnifier on a
   * phone. The caret then goes to the stop nearest the finger. So it moves
   * smoothly between a fraction's top and bottom, and does not jump out beside
   * the fraction while the finger crosses the bar. Leave it off for a tap or
   * click.
   */
  // The tap path, in the gap between stacked rows, falls back to the
  // construct's full-height outer boundary, which made a drag flicker out to
  // the edge and back.
  readonly drag?: boolean;
  /**
   * Only used with `drag`: the caret's current source offset. With it, the
   * caret stays on its current row until the finger moves clearly toward
   * another row. Small wobbles then do not flip it between a fraction's top and
   * bottom. Pass `null` or leave it out on the first move of a drag.
   */
  readonly dragPrevOffset?: number | null;
}

/**
 * Where to draw the caret in a laid-out formula, in pixels. `x` is measured
 * from the formula's left edge; `top` and `bottom` from its baseline, so
 * negative values are above it. Returned by {@link caretRect}.
 *
 * @group Caret and selection
 */
export interface CaretRect {
  readonly x: number;
  readonly top: number;
  readonly bottom: number;
}

/**
 * One highlight rectangle for a selection in a laid-out formula, in pixels.
 * `x` is measured from the formula's left edge; `y` from its baseline, so
 * negative values are above it. Returned by {@link selectionRects}.
 *
 * @group Caret and selection
 */
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
 *
 * @group Caret and selection
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
      // A construct's outer-edge boundary frequently lands exactly on an adjacent
      // glyph's edge (e.g. `a\sqrt{x}` — the root's left edge is also `a`'s right
      // edge). The glyph wins (it carries the true row height), but we must keep
      // the boundary's `partnerX`: it brackets the construct's horizontal extent,
      // which the hit-test needs to tell a click on the construct's body (a wide √
      // stroke) from one genuinely beside it. Lose it and clicks on the sign snap
      // to the outside edge instead of entering the root.
      if (s.partnerX !== undefined && prev.partnerX === undefined) {
        out[out.length - 1] = { ...prev, partnerX: s.partnerX };
      }
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

/**
 * Vertical extent of a box's caret stops / tap target, in pixels about its own
 * baseline. An ink-less box (an explicit spacing command's `\ `/`\quad` unit —
 * zero height AND depth) would yield a degenerate zero-height caret and an
 * unhittable target, so it gets a nominal x-height rise instead. The box's
 * layout dimensions are untouched — only what the caret/hit layer reports.
 */
const INKLESS_RISE_EM = 0.43;
function boxExtent(
  box: { height: number; depth: number },
  y: number,
  fs: number,
): { top: number; bottom: number } {
  if (box.height === 0 && box.depth === 0) {
    return { top: y - INKLESS_RISE_EM * fs, bottom: y };
  }
  return { top: y - box.height * fs, bottom: y + box.depth * fs };
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
    // A shaped fallback run (Arabic, CJK, …) painted as one box carries its own
    // interior boundary stops, already resolved for direction (an RTL run's stops
    // decrease in offset as x grows). Use them instead of the two span edges so
    // the caret can land between the run's characters.
    if (box.textCarets && box.textCarets.length > 0) {
      const top = y - box.height * fs;
      const bottom = y + box.depth * fs;
      for (const c of box.textCarets) {
        out.push({
          offset: c.offset,
          x: x + c.dx * fs,
          y,
          top,
          bottom,
          ...ctx,
        });
      }
      return;
    }
    if (box.span && box.width > 0) {
      const top = y - box.height * fs;
      const bottom = y + box.depth * fs;
      out.push({ offset: box.span.start, x, y, top, bottom, ...ctx });
      const end = box.endCaret;
      out.push({
        offset: box.span.end,
        x: x + (end?.dx ?? box.width) * fs,
        y,
        top,
        bottom,
        ...(end?.height !== undefined ? { caretTop: y - end.height * fs } : {}),
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
    // An indivisible multi-glyph atom (a named operator like `\det`): its letters
    // are span-less, so the only caret stops are the atom's two outer edges on
    // this baseline. Emitting them here (and not descending) keeps the caret from
    // landing between the letters of a command name. Plain baseline stops (not
    // `boundary`) — the atom sits on the baseline, so vertical motion and the
    // hit-test treat its edges like any glyph's.
    if (box.unit && box.span) {
      const { top, bottom } = boxExtent(box, y, fs);
      out.push({ offset: box.span.start, x, y, top, bottom, ...ctx });
      out.push({
        offset: box.span.end,
        x: x + box.width * fs,
        y,
        top,
        bottom,
        ...ctx,
      });
      return;
    }
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
      const rightX = x + box.width * fs;
      out.push({
        offset: box.span.start,
        x,
        y,
        top,
        bottom,
        boundary: true,
        partnerX: rightX,
      });
      out.push({
        offset: box.span.end,
        x: rightX,
        y,
        top,
        bottom,
        boundary: true,
        partnerX: x,
      });
    }
  }
  // rule / path boxes carry no source position.
}

/**
 * Finger-drag hit-test (see {@link HitTestOptions.drag}): the caret stop
 * physically nearest `(x, y)` by plain 2-D distance, taking each stop's own row
 * baseline as its `y`. Nearest-stop resolution follows the finger smoothly
 * through a fraction's stacked rows — a single clean transition at the midpoint
 * between the numerator's and denominator's baselines — without the tap path's
 * leap to the construct's outer boundary in the gap between those rows (the
 * reported magnifier jitter). `stops` must be non-empty.
 */
function dragHitTest(
  stops: CaretStop[],
  x: number,
  y: number,
  prevOffset: number | null,
  hyst: number,
): number {
  // The caret's current stop, for hysteresis. A source offset can own several
  // stops (edges); any of them carries the row y.
  const prevStop =
    prevOffset == null
      ? null
      : (stops.find((s) => s.offset === prevOffset) ?? null);
  const prevRowY = prevStop?.y ?? null;

  let best = stops[0];
  let bestD = Infinity;
  for (const s of stops) {
    // A construct's outer boundary sits on the parent baseline (y ≈ 0) spanning
    // the whole construct width. While the finger is horizontally INSIDE the
    // construct it is the physically-nearest stop whenever the finger passes near
    // the baseline — i.e. exactly in the gap between two stacked rows — which
    // would reintroduce the leap this mode exists to avoid. Skip it there; the
    // finger reaches a boundary by dragging horizontally OUT of the construct,
    // where it is no longer inside `[x, partnerX]`.
    //
    // The skip is hysteresis-aware at the construct's EDGE, because a hard
    // in/out cutoff is a pixel-exact discontinuity: near the parent baseline,
    // one pixel inside bans the boundary (an interior row wins) and one pixel
    // outside hands it a near-zero distance — a wobbling finger flips the caret
    // between a slot's small raised caret and the full-height edge caret every
    // frame (the magnifier jitter at fraction edges). So, symmetric to the row
    // hysteresis below: a caret HELD on an interior stop keeps the boundary
    // skipped until the finger is decisively (`hyst`) past the extent, and a
    // caret RESTING on the boundary itself keeps it live until the finger is
    // decisively back inside.
    if (s.boundary && s.partnerX !== undefined) {
      const left = Math.min(s.x, s.partnerX);
      const right = Math.max(s.x, s.partnerX);
      if (x > left && x < right) {
        const restingHere =
          prevOffset === s.offset && Math.abs(x - s.x) <= hyst;
        if (!restingHere) continue;
      } else if (
        prevStop !== null &&
        !prevStop.boundary &&
        prevStop.x > left &&
        prevStop.x < right &&
        x > left - hyst &&
        x < right + hyst
      ) {
        continue;
      }
    }
    const dx = s.x - x;
    let dyAbs = Math.abs(s.y - y);
    // Row hysteresis: discount the vertical distance of stops on the caret's
    // CURRENT row, so the finger must travel more than `hyst` past the midpoint
    // toward another row before that row wins. Keeps a wobbling finger from
    // flipping between a fraction's tightly-stacked numerator and denominator.
    // Only the ROW choice is affected — horizontal (dx) is untouched.
    if (prevRowY != null && Math.abs(s.y - prevRowY) < 0.5) {
      dyAbs = Math.max(0, dyAbs - hyst);
    }
    const d = dx * dx + dyAbs * dyAbs;
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best.offset;
}

/**
 * Returns the source offset for a click or tap at `(x, y)`. `x` is in pixels
 * from the formula's left edge, `y` from its baseline. Returns `0` when the
 * formula has no caret stops.
 *
 * A click over a row lands in that row, so a click in a numerator lands in the
 * numerator. Otherwise it goes to the nearest stop in x. A click left or right
 * of the content lands at the start or end of that line. In a formula that
 * wraps, that is the clicked line. A click right of a formula that ends in a
 * construct, like `\sqrt{x}`, lands after it, not inside it.
 *
 * For a finger drag, pass `drag: true` (see {@link HitTestOptions}).
 *
 * @group Caret and selection
 */
export function hitTest(
  layout: MathLayout,
  x: number,
  y: number,
  options: HitTestOptions = {},
): number {
  const stops = caretStops(layout);
  if (stops.length === 0) return 0;

  // Finger-drag resolution: resolve to the caret stop physically nearest the
  // finger in 2-D, with row hysteresis. See {@link dragHitTest} — it avoids the
  // tap path's band + boundary logic (which leaps the caret to a construct's
  // OUTER edge in the gap between stacked rows) and keeps a wobbling finger from
  // flipping between rows. The hysteresis margin scales with the font so it is
  // proportional to the row spacing.
  if (options.drag) {
    return dragHitTest(
      stops,
      x,
      y,
      options.dragPrevOffset ?? null,
      layout.fontSize * 0.3,
    );
  }

  let best: CaretStop | null = null;
  let bestDist = Infinity;
  let bestInBand: CaretStop | null = null;
  let bestBandDist = Infinity;
  let minInBandX = Infinity;
  let maxInBandX = -Infinity;
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
    if (y >= s.top && y <= s.bottom) {
      if (s.x < minInBandX) minInBandX = s.x;
      if (s.x > maxInBandX) maxInBandX = s.x;
      if (dist < bestBandDist) {
        bestBandDist = dist;
        bestInBand = s;
      }
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
  // Trust the row `y` picked only while the click is horizontally over that
  // row's content. Past the in-band stops' extent the click is in empty space (a
  // margin): resolve to the extreme caret position on the click's side, kept to
  // the clicked visual line for a wrapped equation — not a taller construct
  // sitting to the side, nor another line's edge (see marginStop).
  const overBand = bestInBand !== null && x >= minInBandX && x <= maxInBandX;
  const chosen = overBand
    ? bestInBand!
    : (marginStop(stops, layout, x, y) ?? best!);

  // A click can land on a construct's own outer boundary while actually falling
  // *inside* its body — the classic case is the wide leading stroke of a √ sign,
  // which carries no caret stop, so its left half is nearest the leading
  // boundary that sits OUTSIDE the construct. When that happens, enter the
  // construct: redirect to the nearest in-band stop within its extent, skipping
  // the opposite outer edge (so we don't jump clear across to the far side).
  // `partnerX` (not the `boundary` flag) is the gate: a construct edge that
  // merged into an adjacent glyph keeps `partnerX` but loses `boundary`, and it
  // still needs to redirect clicks that fell inside the construct's body.
  if (chosen.partnerX !== undefined) {
    const left = Math.min(chosen.x, chosen.partnerX);
    const right = Math.max(chosen.x, chosen.partnerX);
    if (x > left && x < right) {
      // Prefer an interior stop on the click's own row; otherwise fall back to
      // the horizontally-nearest interior stop on any row. The fallback matters
      // for clicks high on a construct's ornament (e.g. the top of a √ sign,
      // above the radicand's row) — every stop in the extent is genuine inner
      // content, so entering at the nearest one still beats resting outside.
      let inner: CaretStop | null = null;
      let innerDist = Infinity;
      let innerAny: CaretStop | null = null;
      let innerAnyDist = Infinity;
      for (const s of stops) {
        if (s === chosen) continue;
        if (s.x < left || s.x > right) continue; // outside the construct
        // Skip the construct's opposite outer edge — landing there means resting
        // beside the construct again, not entering it.
        if (s.boundary && Math.abs(s.x - chosen.partnerX) < 0.01) continue;
        const d = Math.abs(s.x - x);
        if (d < innerAnyDist) {
          innerAnyDist = d;
          innerAny = s;
        }
        if (y < s.top || y > s.bottom) continue; // shares the click's row
        if (d < innerDist) {
          innerDist = d;
          inner = s;
        }
      }
      const target = inner ?? innerAny;
      if (target) return target.offset;
    }
  }
  return chosen.offset;
}

/** Sub-pixel tolerance for treating two caret stops as sharing a column. */
const EDGE_EPS = 0.01;

/**
 * The vertical band (baseline-relative px, +down) of each visual line of a
 * WRAPPED equation, or `null` when the layout is a single line. Only the
 * dedicated wrap container (`ListBox.lineStack`, set by `buildExpressionWrapped`)
 * qualifies — a construct's internally stacked rows (a `\frac`'s numerator over
 * its denominator) are NOT lines and must never split a margin click.
 */
function wrappedLineBands(
  layout: MathLayout,
): Array<{ top: number; bottom: number }> | null {
  const root = layout.box;
  if (root.type !== "list" || !root.lineStack || root.children.length < 2) {
    return null;
  }
  const fs = layout.fontSize;
  return root.children.map((child) => ({
    top: (child.dy - child.box.height) * fs,
    bottom: (child.dy + child.box.depth) * fs,
  }));
}

/**
 * Resolve a margin click (empty space left/right of the content) to the extreme
 * caret position on the click's side. For a wrapped equation the candidates are
 * restricted to the visual line the click is vertically nearest, so clicking in
 * the margin beside a line lands at THAT line's leading/trailing edge. The pick
 * is the horizontally-nearest stop (= the row's far edge for a genuine margin
 * click); a tie at that edge — an inner glyph edge coincident with a construct's
 * outer boundary (`\sqrt{x}`) — breaks toward the OUTER edge in the click's
 * direction, so the caret rests beside the construct, not inside it. Returns
 * `null` only when there are no stops.
 */
function marginStop(
  stops: CaretStop[],
  layout: MathLayout,
  x: number,
  y: number,
): CaretStop | null {
  let candidates = stops;
  const bands = wrappedLineBands(layout);
  if (bands) {
    let band = bands[0];
    let bandDist = Infinity;
    for (const b of bands) {
      const d = y < b.top ? b.top - y : y > b.bottom ? y - b.bottom : 0;
      if (d < bandDist) {
        bandDist = d;
        band = b;
      }
    }
    const inLine = stops.filter(
      (s) => s.y >= band.top - 0.01 && s.y <= band.bottom + 0.01,
    );
    if (inLine.length > 0) candidates = inLine;
  }

  let pick: CaretStop | null = null;
  let pickDist = Infinity;
  for (const s of candidates) {
    const dist = Math.abs(s.x - x);
    if (pick === null || dist < pickDist - EDGE_EPS) {
      pickDist = dist;
      pick = s;
    } else if (dist <= pickDist + EDGE_EPS) {
      // Same column within sub-pixel tolerance (an inner glyph edge and the
      // construct boundary sitting on it are computed independently, so their x
      // differ by a float epsilon rather than being bit-equal): keep the stop
      // further out in the travel direction — the larger source offset to the
      // right of the column, the smaller to its left — so the caret rests beside
      // the construct rather than inside it.
      const outward =
        x >= s.x ? s.offset > pick.offset : s.offset < pick.offset;
      if (outward) {
        pick = s;
        if (dist < pickDist) pickDist = dist;
      }
    }
  }
  return pick;
}

/**
 * Minimum caret height as a fraction of the layout font size. A stop on a tiny
 * glyph (a superscript `2`, a fraction's single-letter denominator) yields a
 * span of only a few pixels; without a floor the drawn caret is a razor-thin
 * nub. The floor is font-relative so it scales with the formula (an inline chip
 * in a big heading gets a proportionally bigger minimum, never the host line's
 * full text height). Taller rows keep hugging — the floor only lifts short ones.
 */
const MIN_CARET_HEIGHT_EM = 0.5;

/**
 * Returns where to draw the caret for a source `offset`. Returns `null` when
 * the formula has no caret stops. If no stop sits exactly at `offset`, the
 * nearest one is used.
 *
 * One offset can have several stops, for example on both sides of the space
 * around a `+`. For a selection end, pass `edge` so the handle hugs the
 * selected text. `"start"` takes the rightmost stop and `"end"` takes the
 * leftmost.
 *
 * Leave `edge` out for a plain caret. Just after a construct like `x^{2}`, the
 * caret then sits on the main line, not up on the script. Just before a
 * construct, it keeps the height of what comes before it.
 *
 * @group Caret and selection
 */
// A leading boundary must not win the bare-caret tie: between `\det` and a
// following matrix the caret stays `\det`-tall. Short carets are lifted to
// MIN_CARET_HEIGHT_EM of the font size, capped at the formula's own height.
export function caretRect(
  layout: MathLayout,
  offset: number,
  edge?: "start" | "end",
): CaretRect | null {
  const stops = caretStops(layout);
  if (stops.length === 0) return null;
  let best = stops[0];
  let bestDist = Math.abs(stops[0].offset - offset);
  for (const s of stops) {
    const d = Math.abs(s.offset - offset);
    if (d < bestDist) {
      bestDist = d;
      best = s;
    } else if (d === bestDist && d === 0) {
      // Exact-offset tie between coincident stops — resolve by `edge` for a
      // selection endpoint (hug the selected side), else by the boundary rule.
      if (edge === "start") {
        if (s.x > best.x) best = s;
      } else if (edge === "end") {
        if (s.x < best.x) best = s;
      } else if (s.boundary && !best.boundary && s.partnerX! < s.x) {
        // A construct boundary wins the bare-caret tie ONLY when it is the
        // construct's TRAILING edge — its partner (the other outer edge) sits to
        // its LEFT, so the construct lies BEHIND the caret. The caret then takes
        // the height of what PRECEDES it: past `x^{2}` it drops to the main
        // baseline beside the whole script (the construct it just left), rather
        // than staying up on the tiny `2` row. A LEADING boundary (partner to the
        // right, construct AHEAD) must NOT win: between `\det` and a following
        // matrix the caret keeps `\det`'s height instead of leaping to the full
        // height of the matrix it has not yet entered. When the previous glyph's
        // edge coincides in x with the boundary they de-duplicate to the glyph,
        // which already yields the preceding height — this only decides the
        // spaced case (an operator's med/thick space before an Inner atom).
        best = s;
      }
    }
  }
  // Floor a short span to a legible minimum, expanding about the stop's centre so
  // it stays on its row. Never exceed the formula's own extent, so a small
  // single-row chip is matched, not overshot.
  let top = best.caretTop ?? best.top;
  let bottom = best.bottom;
  const minHeight = Math.min(
    layout.fontSize * MIN_CARET_HEIGHT_EM,
    layout.height + layout.depth,
  );
  const grow = (minHeight - (bottom - top)) / 2;
  if (grow > 0) {
    top -= grow;
    bottom += grow;
  }
  return { x: best.x, top, bottom };
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
 * Moves the caret one row up or down inside a formula, for example from a
 * fraction's top to its bottom, or from a base to its superscript. Returns the
 * new source offset. Returns `null` when there is no row in that direction, so
 * you can move the caret out of the formula as usual.
 *
 * `preferredX` is the caret's x in pixels from the formula's left edge. The
 * stop closest to it in x wins, so the caret lands straight above or below.
 *
 * When a script has both parts, down from the superscript goes straight to the
 * subscript, and up from the subscript goes to the superscript. The base
 * between them is skipped.
 *
 * @group Caret and selection
 */
// Score = |dx| * VERTICAL_X_WEIGHT + dy, so a baseline sibling beside a
// fraction loses on x even when it is closer. On a tie in the script jump, the
// first (leftmost) stop wins.
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
 * Options for {@link spanAtPoint}.
 *
 * @group Caret and selection
 */
export interface SpanAtPointOptions {
  /**
   * Minimum width/height, in CSS pixels, of an atom's tap target. A `+`/`=` glyph
   * (and the space around it) is a small target on a touch screen; padding each
   * atom's box to at least this makes a finger-sized tap land on it.
   */
  readonly minTargetSize?: number;
}

/** A candidate atom under a tap: its box, plus the nearest enclosing construct. */
interface AtomHit {
  left: number;
  right: number;
  top: number;
  bottom: number;
  /** Span of the glyph itself. */
  glyph: { start: number; end: number };
  /**
   * Span of the nearest enclosing boundary construct (fraction, script, root, …),
   * or null at the top level. A double-tap selects the WHOLE construct a glyph
   * lives in — tapping a fraction's numerator selects the `\frac` — so this wins
   * over the bare glyph when set. The NEAREST (innermost) construct is kept, so a
   * nested `\frac{x^2}{d}` selects the inner `x^{2}`, not the whole fraction.
   */
  construct: { start: number; end: number } | null;
}

function collectAtomHits(
  box: Box,
  x: number,
  y: number,
  fs: number,
  construct: { start: number; end: number } | null,
  out: AtomHit[],
): void {
  if (box.type === "glyph") {
    if (box.span && box.width > 0) {
      out.push({
        left: x,
        right: x + box.width * fs,
        top: y - box.height * fs,
        bottom: y + box.depth * fs,
        glyph: { start: box.span.start, end: box.span.end },
        construct,
      });
    }
    return;
  }
  if (box.type === "placeholder") {
    // An empty editable slot: it has no glyph, so a tap on it selects the
    // construct it belongs to (its `construct`), never a zero-width span.
    out.push({
      left: x,
      right: x + box.width * fs,
      top: y - box.height * fs,
      bottom: y + box.depth * fs,
      glyph: { start: box.offset, end: box.offset },
      construct,
    });
    return;
  }
  if (box.type === "list") {
    // A named-operator atom (`\det`) is one unit whose letters are span-less: the
    // whole box is the tap target, selecting the operator's own span. Emit a
    // single hit and don't descend (there is nothing span-bearing below).
    if (box.unit && box.span && box.width > 0) {
      const { top, bottom } = boxExtent(box, y, fs);
      out.push({
        left: x,
        right: x + box.width * fs,
        top,
        bottom,
        glyph: { start: box.span.start, end: box.span.end },
        construct,
      });
      return;
    }
    // Descend into the nearest enclosing boundary construct so inner glyphs carry
    // it; an inline-flow wrapper (`ord`, a font command) is not a boundary and
    // leaves the current construct in place. A radical counts as a boundary
    // construct too (its surd/vinculum have no source span of their own, so a bare
    // radicand's glyphs would otherwise carry no construct at all) — but only as
    // ONE level: a construct nested inside the radicand (a matrix, a `\frac`) is
    // the CLOSER level and overrides it further down, so a double-tap takes that
    // inner construct rather than ballooning to the whole radical. See
    // {@link ListBox.radical}.
    const isConstructBox = (box.boundary || box.radical === true) && box.span;
    const inner = isConstructBox ? box.span! : construct;
    for (const child of box.children) {
      collectAtomHits(
        child.box,
        x + child.dx * fs,
        y + child.dy * fs,
        fs,
        inner,
        out,
      );
    }
  }
}

/**
 * Returns the source span that a double-click or double-tap at `(x, y)`
 * selects. That is the smallest construct the point is in, or the single atom
 * when it is not in one. For example, a tap on a fraction's top selects the
 * whole fraction. Returns `null` for an empty formula.
 *
 * With the `minTargetSize` option, each atom's box counts as at least that wide
 * and tall, so small operators like `+` or `=` are easy to hit. If no box holds
 * the point, such as a tap above or below a row, it picks the atom nearest in
 * x.
 *
 * {@link unitAt} does a similar job from a caret offset. Use this one for a
 * pointer, so an operator between two constructs, like the `+` in `x^2+y^2`,
 * can still be selected.
 *
 * @group Caret and selection
 */
export function spanAtPoint(
  layout: MathLayout,
  x: number,
  y: number,
  options: SpanAtPointOptions = {},
): { start: number; end: number } | null {
  const hits: AtomHit[] = [];
  collectAtomHits(layout.box, 0, 0, layout.fontSize, null, hits);
  if (hits.length === 0) return null;

  const pad = options.minTargetSize ?? 0;
  let contained: AtomHit | null = null;
  let containedDist = Infinity;
  let nearest: AtomHit | null = null;
  let nearestDist = Infinity;
  for (const h of hits) {
    const cx = (h.left + h.right) / 2;
    const cy = (h.top + h.bottom) / 2;
    const halfW = Math.max((h.right - h.left) / 2, pad / 2);
    const halfH = Math.max((h.bottom - h.top) / 2, pad / 2);
    const dx = Math.abs(x - cx);
    const dy = Math.abs(y - cy);
    if (dx <= halfW && dy <= halfH) {
      const d = Math.hypot(dx, dy);
      if (d < containedDist) {
        containedDist = d;
        contained = h;
      }
    }
    // Horizontal distance to the box (0 while over it) — the row-agnostic
    // fallback so a tap in the vertical slack still selects its column.
    const hxd = x < h.left ? h.left - x : x > h.right ? x - h.right : 0;
    if (hxd < nearestDist) {
      nearestDist = hxd;
      nearest = h;
    }
  }
  const chosen = contained ?? nearest!;
  return chosen.construct ?? chosen.glyph;
}

/**
 * Returns the highlight rectangles for the source range `[start, end)`. The
 * ends may come in either order. You get one rectangle per visual row, so a
 * formula that wraps gets one per line, not one tall block across the gaps.
 * Returns an empty list when nothing in the range is drawn.
 *
 * @group Caret and selection
 */
export function selectionRects(
  layout: MathLayout,
  start: number,
  end: number,
): SelectionRect[] {
  if (end < start) [start, end] = [end, start];
  const fs = layout.fontSize;
  const segs: {
    x0: number;
    x1: number;
    top: number;
    bottom: number;
    y: number;
  }[] = [];
  collectSelected(layout.box, 0, 0, fs, start, end, segs);
  if (segs.length === 0) return [];
  // Group by row baseline (glyphs on one text line share `y` exactly), then
  // bound each group. Rounding keeps near-equal baselines in the same bucket.
  const rows = new Map<
    number,
    { x0: number; x1: number; top: number; bottom: number }
  >();
  for (const s of segs) {
    const key = Math.round(s.y * 100) / 100;
    const r = rows.get(key);
    if (!r) {
      rows.set(key, { x0: s.x0, x1: s.x1, top: s.top, bottom: s.bottom });
    } else {
      r.x0 = Math.min(r.x0, s.x0);
      r.x1 = Math.max(r.x1, s.x1);
      r.top = Math.min(r.top, s.top);
      r.bottom = Math.max(r.bottom, s.bottom);
    }
  }
  return [...rows.values()].map((r) => ({
    x: r.x0,
    y: r.top,
    width: r.x1 - r.x0,
    height: r.bottom - r.top,
  }));
}

/**
 * Horizontal extent of a box's actually-DRAWN content (glyphs, rules, paths and
 * placeholder slots), in layout coordinates. A list box's advance `width` can
 * exceed this — a big operator reserves trailing italic advance for a following
 * script — so a selection highlight must hug the ink, never that empty advance.
 * Returns null when the subtree draws nothing, so the caller keeps the box's own
 * bounds as a fallback.
 */
function drawnXBounds(
  box: Box,
  x: number,
  fs: number,
): { x0: number; x1: number } | null {
  switch (box.type) {
    case "glyph":
      return box.width > 0 ? { x0: x, x1: x + box.width * fs } : null;
    case "rule":
    case "path":
    case "placeholder":
      return { x0: x, x1: x + box.width * fs };
    case "list": {
      let x0 = Infinity;
      let x1 = -Infinity;
      for (const child of box.children) {
        const b = drawnXBounds(child.box, x + child.dx * fs, fs);
        if (b) {
          x0 = Math.min(x0, b.x0);
          x1 = Math.max(x1, b.x1);
        }
      }
      return x1 > x0 ? { x0, x1 } : null;
    }
  }
}

function collectSelected(
  box: Box,
  x: number,
  y: number,
  fs: number,
  start: number,
  end: number,
  out: { x0: number; x1: number; top: number; bottom: number; y: number }[],
): void {
  if (box.type === "glyph") {
    // A shaped fallback run: highlight only the boundaries the selection covers,
    // so selecting part of a run (e.g. two of four Arabic letters) hugs those
    // characters. The boundary x's are visual, so min/max gives the extent for
    // either direction.
    if (box.textCarets && box.textCarets.length > 0) {
      let lo = Infinity;
      let hi = -Infinity;
      let count = 0;
      for (const c of box.textCarets) {
        if (c.offset >= start && c.offset <= end) {
          lo = Math.min(lo, c.dx);
          hi = Math.max(hi, c.dx);
          count++;
        }
      }
      if (count >= 2) {
        out.push({
          x0: x + lo * fs,
          x1: x + hi * fs,
          top: y - box.height * fs,
          bottom: y + box.depth * fs,
          y,
        });
      }
      return;
    }
    if (box.span && box.span.start >= start && box.span.end <= end) {
      out.push({
        x0: x,
        x1: x + box.width * fs,
        top: y - box.height * fs,
        bottom: y + box.depth * fs,
        y,
      });
    }
    return;
  }
  if (box.type === "list") {
    // A construct (a list box with a source span) that falls ENTIRELY within
    // the selection highlights as one solid rect — so the whole thing is
    // covered, including empty slots, rules and delimiters that are not glyph
    // children (e.g. `\frac{}{b}` selected whole would otherwise light up only
    // the `b`). A partial overlap descends to highlight the glyphs.
    if (box.span && box.span.start >= start && box.span.end <= end) {
      // Match the construct's caret-stop extent, so the highlight starts where
      // its edge caret sits and ends where the other does — "nothing more,
      // nothing less". A boundary construct (fraction, root, delimited group)
      // owns edge stops at its box edges, so its full advance width IS the
      // extent (covering nulldelimiter side-space and the bar the same way the
      // caret does). A non-boundary wrapper has no edge stops — its carets sit at
      // the glyph edges — so hug the drawn ink: a big operator floats its glyph
      // in a trailing italic-correction advance (room a following script leans
      // into), and filling to `box.width` there bleeds the green past the ∫ into
      // the empty script column (the reported "selects more than it should").
      // Vertical extent stays the construct's own height/depth so stacked slots
      // (a fraction's halves) remain fully covered.
      const drawn = box.boundary ? null : drawnXBounds(box, x, fs);
      const { top, bottom } = boxExtent(box, y, fs);
      out.push({
        x0: drawn ? drawn.x0 : x,
        x1: drawn ? drawn.x1 : x + box.width * fs,
        top,
        bottom,
        y,
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

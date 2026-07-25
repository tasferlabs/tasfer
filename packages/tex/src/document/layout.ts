import {
  caretRect,
  type CaretStop,
  caretStops as sourceCaretStops,
  hitTest,
  type HitTestOptions,
} from "../edit/caret";
import type { Box } from "../layout/box";
import type { MathItemId, MathNode } from "./model";
import type {
  MathDocumentSourceProjection,
  ProjectedMathAnchor,
  ProjectedMathItem,
} from "./print";

/** A stable caret between children of one identity-bearing row. */
export interface MathDocumentRowPosition {
  readonly kind: "row";
  readonly rowId: MathItemId;
  /** Child boundary, from `0` through `row.children.length`. */
  readonly offset: number;
  /** Node whose outer edge produced this position, when there is one. */
  readonly nodeId?: MathItemId;
}

/** A stable caret inside one CRDT-editable string field. */
export interface MathDocumentFieldPosition {
  readonly kind: "field";
  readonly rowId: MathItemId;
  readonly nodeId: MathItemId;
  readonly field: "text" | "latex" | "name";
  /** UTF-16 offset in the field value, matching JavaScript string indexing. */
  readonly offset: number;
}

export type MathDocumentCaretPosition =
  | MathDocumentRowPosition
  | MathDocumentFieldPosition;

/** Lookup address; a globally-stable node id makes `rowId` optional for fields. */
export type MathDocumentCaretAddress =
  | MathDocumentRowPosition
  | (Omit<MathDocumentFieldPosition, "rowId"> & {
      readonly rowId?: MathItemId;
    });

/** One visual caret location, with all stable tree positions it represents. */
export interface MathDocumentCaretStop extends Omit<CaretStop, "offset"> {
  /**
   * Offset in the transient canonical source used by the current painter.
   * This is a bridge for existing `caretRect`/selection code, not editor state.
   */
  readonly sourceOffset: number;
  /** Stable aliases at this visual location (for example row edge + text edge). */
  readonly positions: readonly MathDocumentCaretPosition[];
}

export interface MathDocumentBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type MathDocumentItemType =
  | "root"
  | "row"
  | "matrix-row"
  | "matrix-cell"
  | MathNode["type"];

/** Visual geometry for one stable root, row, matrix slot, or semantic node. */
export interface MathDocumentItemLayout {
  readonly id: MathItemId;
  readonly type: MathDocumentItemType;
  readonly bounds: MathDocumentBounds;
  /** Baseline in pixels relative to the formula baseline (+down). */
  readonly baseline: number;
  /** All visual caret stops contained by this item's projected range. */
  readonly caretStops: readonly MathDocumentCaretStop[];
  /**
   * The item this one sits directly inside — a node's parent row, or the node a
   * row/matrix slot is a slot of. Absent for the document root and its body.
   * This is the structural chain {@link mathDocumentCaretVertical} walks; it is
   * derived from the identity tree, never from caret geometry.
   */
  readonly parentId?: MathItemId;
}

/**
 * Paintable math layout plus identity-keyed geometry for the authoritative
 * {@link MathDocument}. The inherited box tree remains opaque to consumers.
 */
export interface MathDocumentLayout {
  readonly box: Box;
  readonly fontSize: number;
  readonly displayMode: boolean;
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  readonly depthBelowBaseline: number;
  readonly items: ReadonlyMap<MathItemId, MathDocumentItemLayout>;
  readonly caretStops: readonly MathDocumentCaretStop[];
}

export interface MathDocumentHitTestOptions extends Omit<
  HitTestOptions,
  "dragPrevOffset"
> {
  /** Stable equivalent of the source-oriented hit tester's drag offset. */
  readonly dragPrevPosition?: MathDocumentCaretAddress | null;
}

interface BaseMathLayout {
  readonly box: Box;
  readonly fontSize: number;
  readonly displayMode: boolean;
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  readonly depthBelowBaseline: number;
}

/** @internal Attach stable identity geometry to an existing paintable layout. */
export function createMathDocumentLayout(
  projection: MathDocumentSourceProjection,
  layout: BaseMathLayout,
): MathDocumentLayout {
  const anchorsByOffset = groupAnchors(projection.anchors);
  const mappedStops = sourceCaretStops(layout).map((stop) =>
    mapCaretStop(stop, anchorsByOffset, projection),
  );
  attachUnrepresentedAnchors(mappedStops, projection);
  addMissingEmptyRowStops(mappedStops, projection, layout.fontSize);
  mappedStops.sort(
    (left, right) => left.sourceOffset - right.sourceOffset || left.x - right.x,
  );

  const samples: BoxSample[] = [];
  collectBoxSamples(layout.box, 0, 0, layout.fontSize, samples);
  const parents = resolveItemParents(projection.items);
  const items = new Map<MathItemId, MathDocumentItemLayout>();
  for (const item of projection.items) {
    const itemStops = mappedStops.filter(
      (stop) =>
        stop.sourceOffset >= item.start && stop.sourceOffset <= item.end,
    );
    const geometry = geometryForItem(item, samples, itemStops);
    const parentId = parents.get(item.id);
    items.set(item.id, {
      id: item.id,
      type: item.type,
      bounds: geometry.bounds,
      baseline: geometry.baseline,
      caretStops: itemStops,
      ...(parentId === undefined ? {} : { parentId }),
    });
  }

  return { ...layout, items, caretStops: mappedStops };
}

/** Resolve a stable tree position to its visual caret and bridge source offset. */
export function mathDocumentCaretStop(
  layout: MathDocumentLayout,
  position: MathDocumentCaretAddress,
): MathDocumentCaretStop | null {
  return (
    layout.caretStops.find((stop) =>
      stop.positions.some((candidate) => positionsEqual(candidate, position)),
    ) ?? null
  );
}

/**
 * Resolve one visual row above/below a stable tree-addressed caret.
 *
 * The current stop is resolved by identity rather than by its transient source
 * offset. This matters at aliased construct boundaries, where an outer row edge
 * and an inner field edge may share one printed offset but occupy different
 * visual rows.
 *
 * Vertical motion is STRUCTURAL, not free geometry: it only ever moves between
 * the stacked slots of a construct the caret is ALREADY inside (a fraction's
 * halves, a script pair, a matrix's rows), walking outward through the identity
 * chain when the innermost one has no row on that side. A caret on a row that
 * stacks nothing — the formula's own body, a `\sqrt`'s radicand, a delimited
 * body — is flat, so it has nowhere to go and returns null: the host then
 * carries the press on to the line above/below. Geometry alone would instead
 * grab the visually nearest stop anywhere in the formula, so ↑ on a long flat
 * line jumped sideways into some unrelated superscript.
 *
 * Within the chosen construct horizontal distance dominates so a fraction
 * retains the caret column; paired super/subscripts use their shared construct
 * identity to step over the base row directly.
 */
export function mathDocumentCaretVertical(
  layout: MathDocumentLayout,
  position: MathDocumentCaretAddress,
  direction: "up" | "down",
  preferredX?: number,
): MathDocumentCaretStop | null {
  const current = mathDocumentCaretStop(layout, position);
  if (!current) return null;
  const targetX = preferredX ?? current.x;

  if (current.construct !== undefined) {
    const wantedSlot =
      direction === "down" && current.slot === "sup"
        ? "sub"
        : direction === "up" && current.slot === "sub"
          ? "sup"
          : null;
    if (wantedSlot) {
      let target: MathDocumentCaretStop | null = null;
      let targetDistance = Infinity;
      for (const stop of layout.caretStops) {
        if (stop.construct !== current.construct || stop.slot !== wantedSlot) {
          continue;
        }
        const distance = Math.abs(stop.x - targetX);
        if (distance < targetDistance) {
          targetDistance = distance;
          target = stop;
        }
      }
      if (target) return target;
    }
  }

  // The slot the caret is in, then each enclosing one — a stacked construct is
  // asked for a row on the requested side before the walk widens to its parent.
  const rowId = caretRowId(current, position);
  let origin = rowId === undefined ? undefined : layout.items.get(rowId);
  // Keystrokes run this walk: a malformed chain must dead-end, never spin.
  const seen = new Set<MathItemId>();
  while (origin && !seen.has(origin.id)) {
    seen.add(origin.id);
    const parent =
      origin.parentId === undefined
        ? undefined
        : layout.items.get(origin.parentId);
    if (!parent) return null;
    if (STACKED_CONSTRUCTS.has(parent.type)) {
      const target = stackedSlotStop(
        parent,
        origin,
        current,
        targetX,
        direction,
      );
      if (target) return target;
    }
    origin = parent;
  }
  return null;
}

/** Construct types whose slots occupy their own stacked rows. */
const STACKED_CONSTRUCTS: ReadonlySet<MathDocumentItemType> = new Set([
  "fraction",
  "matrix",
  "radical",
  "scripts",
  "stack",
]);

/** Rows nearer than this share the caret's row and are not a target. */
const ROW_EPSILON = 0.5;

/** How much more horizontal distance counts than vertical when scoring rows. */
const HORIZONTAL_WEIGHT = 3;

/**
 * Best stop for a vertical step inside one stacked `construct`, coming out of
 * its `origin` slot. Everything `origin` covers is excluded — its own row is not
 * a target, and neither is a construct nested INSIDE it (reaching those needs a
 * caret in them, exactly as reaching this one did). Outer-edge boundary stops
 * are skipped: they sit on the parent baseline, not on a row of their own.
 */
function stackedSlotStop(
  construct: MathDocumentItemLayout,
  origin: MathDocumentItemLayout,
  current: MathDocumentCaretStop,
  targetX: number,
  direction: "up" | "down",
): MathDocumentCaretStop | null {
  const covered = new Set(origin.caretStops);
  let target: MathDocumentCaretStop | null = null;
  let targetScore = Infinity;
  for (const stop of construct.caretStops) {
    if (stop.boundary || covered.has(stop)) continue;
    const verticalDistance =
      direction === "up" ? current.y - stop.y : stop.y - current.y;
    if (verticalDistance <= ROW_EPSILON) continue;
    const score =
      Math.abs(stop.x - targetX) * HORIZONTAL_WEIGHT + verticalDistance;
    if (score < targetScore) {
      targetScore = score;
      target = stop;
    }
  }
  return target;
}

/**
 * The row the caret rests in. A field address may omit its row, so the stop's
 * matching alias supplies it — never another alias at the same visual location,
 * which can belong to an enclosing row.
 */
function caretRowId(
  current: MathDocumentCaretStop,
  position: MathDocumentCaretAddress,
): MathItemId | undefined {
  if (position.rowId !== undefined) return position.rowId;
  return current.positions.find((candidate) =>
    positionsEqual(candidate, position),
  )?.rowId;
}

/**
 * Structural parent of every projected item. Nodes carry their parent row; rows
 * and matrix slots are printed without an owner, so theirs is the innermost node
 * whose projected range covers them.
 *
 * A node that fills its row completely (`{\frac{a}{b}}`, or a formula that IS
 * one fraction) projects the SAME range as that row, so range containment alone
 * would make the two each other's parent and any walk up the chain would spin
 * forever. A node's own parent row is therefore never a candidate to be its
 * child — that single exclusion is what keeps the relation a tree. The formula
 * body, whose every child is excluded this way, correctly ends up with no owner.
 */
function resolveItemParents(
  items: readonly ProjectedMathItem[],
): ReadonlyMap<MathItemId, MathItemId> {
  const parents = new Map<MathItemId, MathItemId>();
  const nodes = items.filter((item) => item.parentRowId !== undefined);
  for (const item of items) {
    if (item.parentRowId !== undefined) {
      parents.set(item.id, item.parentRowId);
      continue;
    }
    let owner: ProjectedMathItem | undefined;
    for (const node of nodes) {
      if (node.id === item.id || node.parentRowId === item.id) continue;
      if (node.start > item.start || node.end < item.end) continue;
      if (owner && node.end - node.start >= owner.end - owner.start) continue;
      owner = node;
    }
    if (owner) parents.set(item.id, owner.id);
  }
  return parents;
}

/** Resolve a legacy/source hit to the nearest stable tree-addressed caret. */
export function mathDocumentCaretFromSourceOffset(
  layout: MathDocumentLayout,
  sourceOffset: number,
): MathDocumentCaretStop | null {
  if (layout.caretStops.length === 0) return null;
  let distance = Infinity;
  let candidates: MathDocumentCaretStop[] = [];
  for (const stop of layout.caretStops) {
    const nextDistance = Math.abs(stop.sourceOffset - sourceOffset);
    if (nextDistance < distance) {
      distance = nextDistance;
      candidates = [stop];
    } else if (nextDistance === distance) {
      candidates.push(stop);
    }
  }
  if (candidates.length <= 1) return candidates[0] ?? null;

  const rect = caretRect(layout, candidates[0].sourceOffset);
  if (!rect) return candidates[0];
  return candidates.reduce((best, candidate) =>
    caretGeometryDistance(candidate, rect) < caretGeometryDistance(best, rect)
      ? candidate
      : best,
  );
}

/** Hit-test pixels directly into a stable tree-addressed caret. */
export function hitTestMathDocument(
  layout: MathDocumentLayout,
  x: number,
  y: number,
  options: MathDocumentHitTestOptions = {},
): MathDocumentCaretStop | null {
  const { dragPrevPosition, ...sourceOptions } = options;
  const previous = dragPrevPosition
    ? mathDocumentCaretStop(layout, dragPrevPosition)?.sourceOffset
    : null;
  const sourceOffset = hitTest(layout, x, y, {
    ...sourceOptions,
    dragPrevOffset: previous,
  });
  return mathDocumentCaretFromSourceOffset(layout, sourceOffset);
}

function groupAnchors(
  anchors: readonly ProjectedMathAnchor[],
): ReadonlyMap<number, readonly ProjectedMathAnchor[]> {
  const groups = new Map<number, ProjectedMathAnchor[]>();
  for (const anchor of anchors) {
    const group = groups.get(anchor.sourceOffset);
    if (group) group.push(anchor);
    else groups.set(anchor.sourceOffset, [anchor]);
  }
  return groups;
}

function mapCaretStop(
  stop: CaretStop,
  anchorsByOffset: ReadonlyMap<number, readonly ProjectedMathAnchor[]>,
  projection: MathDocumentSourceProjection,
): MathDocumentCaretStop {
  const { offset, ...geometry } = stop;
  const exact = anchorsByOffset.get(offset) ?? [];
  const anchors =
    exact.length > 0 ? exact : fallbackAnchors(offset, projection);
  return {
    ...geometry,
    sourceOffset: offset,
    positions: dedupePositions(anchors.map(anchorToPosition)),
  };
}

function fallbackAnchors(
  sourceOffset: number,
  projection: MathDocumentSourceProjection,
): readonly ProjectedMathAnchor[] {
  const rows = projection.items
    .filter(
      (item) =>
        item.type === "row" &&
        sourceOffset >= item.start &&
        sourceOffset <= item.end,
    )
    .sort((left, right) => left.end - left.start - (right.end - right.start));
  const row = rows[0];
  if (!row) return [];
  const candidates = projection.anchors.filter(
    (anchor) => anchor.kind === "row" && anchor.rowId === row.id,
  );
  if (candidates.length === 0) return [];
  return [
    candidates.reduce((best, candidate) =>
      Math.abs(candidate.sourceOffset - sourceOffset) <
      Math.abs(best.sourceOffset - sourceOffset)
        ? candidate
        : best,
    ),
  ];
}

function anchorToPosition(
  anchor: ProjectedMathAnchor,
): MathDocumentCaretPosition {
  if (anchor.kind === "row") {
    return {
      kind: "row",
      rowId: anchor.rowId,
      offset: anchor.offset,
      ...(anchor.nodeId === undefined ? {} : { nodeId: anchor.nodeId }),
    };
  }
  return {
    kind: "field",
    rowId: anchor.rowId,
    nodeId: anchor.nodeId,
    field: anchor.field,
    offset: anchor.offset,
  };
}

function attachUnrepresentedAnchors(
  stops: MathDocumentCaretStop[],
  projection: MathDocumentSourceProjection,
): void {
  for (const anchor of projection.anchors) {
    const position = anchorToPosition(anchor);
    if (
      stops.some((stop) =>
        stop.positions.some((candidate) => positionsEqual(candidate, position)),
      )
    ) {
      continue;
    }

    const ownerId = anchor.nodeId ?? anchor.rowId;
    const owner = projection.items.find((item) => item.id === ownerId);
    const candidates = owner
      ? stops.filter(
          (stop) =>
            stop.sourceOffset >= owner.start && stop.sourceOffset <= owner.end,
        )
      : stops;
    if (candidates.length === 0) continue;

    const nearest = candidates.reduce((best, candidate) =>
      Math.abs(candidate.sourceOffset - anchor.sourceOffset) <
      Math.abs(best.sourceOffset - anchor.sourceOffset)
        ? candidate
        : best,
    );
    const index = stops.indexOf(nearest);
    stops[index] = {
      ...nearest,
      positions: dedupePositions([...nearest.positions, position]),
    };
  }
}

function dedupePositions(
  positions: readonly MathDocumentCaretPosition[],
): MathDocumentCaretPosition[] {
  const seen = new Set<string>();
  const result: MathDocumentCaretPosition[] = [];
  for (const position of positions) {
    const key = positionKey(position);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(position);
  }
  return result;
}

function positionKey(position: MathDocumentCaretPosition): string {
  return position.kind === "row"
    ? `row:${position.rowId}:${position.offset}:${position.nodeId ?? ""}`
    : `field:${position.rowId}:${position.nodeId}:${position.field}:${position.offset}`;
}

function positionsEqual(
  candidate: MathDocumentCaretPosition,
  requested: MathDocumentCaretAddress,
): boolean {
  if (candidate.kind !== requested.kind) return false;
  if (candidate.kind === "field" && requested.kind === "field") {
    return (
      (requested.rowId === undefined || candidate.rowId === requested.rowId) &&
      candidate.nodeId === requested.nodeId &&
      candidate.field === requested.field &&
      candidate.offset === requested.offset
    );
  }
  if (candidate.kind === "row" && requested.kind === "row") {
    return (
      candidate.rowId === requested.rowId &&
      candidate.offset === requested.offset &&
      (requested.nodeId === undefined || candidate.nodeId === requested.nodeId)
    );
  }
  return false;
}

function addMissingEmptyRowStops(
  stops: MathDocumentCaretStop[],
  projection: MathDocumentSourceProjection,
  fontSize: number,
): void {
  for (const row of projection.items) {
    if (row.type !== "row" || row.start !== row.end) continue;
    if (
      stops.some((stop) =>
        stop.positions.some(
          (position) => position.kind === "row" && position.rowId === row.id,
        ),
      )
    ) {
      continue;
    }
    const anchors = projection.anchors.filter(
      (anchor) => anchor.kind === "row" && anchor.rowId === row.id,
    );
    if (anchors.length === 0) continue;
    const nearest = nearestStop(stops, row.start);
    stops.push({
      sourceOffset: row.start,
      x: nearest?.x ?? 0,
      y: nearest?.y ?? 0,
      top: nearest?.top ?? -fontSize * 0.7,
      bottom: nearest?.bottom ?? fontSize * 0.2,
      positions: dedupePositions(anchors.map(anchorToPosition)),
    });
  }
}

function nearestStop(
  stops: readonly MathDocumentCaretStop[],
  sourceOffset: number,
): MathDocumentCaretStop | null {
  if (stops.length === 0) return null;
  return stops.reduce((best, candidate) =>
    Math.abs(candidate.sourceOffset - sourceOffset) <
    Math.abs(best.sourceOffset - sourceOffset)
      ? candidate
      : best,
  );
}

interface BoxSample {
  readonly start?: number;
  readonly end?: number;
  readonly offset?: number;
  readonly bounds: MathDocumentBounds;
  readonly baseline: number;
}

function collectBoxSamples(
  box: Box,
  x: number,
  baseline: number,
  fontSize: number,
  samples: BoxSample[],
): void {
  const bounds = {
    x,
    y: baseline - box.height * fontSize,
    width: box.width * fontSize,
    height: (box.height + box.depth) * fontSize,
  };
  if ((box.type === "glyph" || box.type === "list") && box.span) {
    samples.push({
      start: box.span.start,
      end: box.span.end,
      bounds,
      baseline,
    });
  } else if (box.type === "placeholder") {
    samples.push({ offset: box.offset, bounds, baseline });
  }

  if (box.type !== "list") return;
  for (const child of box.children) {
    collectBoxSamples(
      child.box,
      x + child.dx * fontSize,
      baseline + child.dy * fontSize,
      fontSize,
      samples,
    );
  }
}

function geometryForItem(
  item: ProjectedMathItem,
  samples: readonly BoxSample[],
  stops: readonly MathDocumentCaretStop[],
): { bounds: MathDocumentBounds; baseline: number } {
  const exact = samples.filter(
    (sample) => sample.start === item.start && sample.end === item.end,
  );
  if (exact.length > 0) {
    const largest = exact.reduce((best, candidate) =>
      sampleArea(candidate) > sampleArea(best) ? candidate : best,
    );
    return { bounds: largest.bounds, baseline: largest.baseline };
  }

  const contained = samples.filter((sample) =>
    sample.start !== undefined && sample.end !== undefined
      ? sample.start >= item.start && sample.end <= item.end
      : sample.offset !== undefined &&
        sample.offset >= item.start &&
        sample.offset <= item.end,
  );
  if (contained.length > 0) {
    return {
      bounds: unionBounds(contained.map((sample) => sample.bounds)),
      baseline: contained[0].baseline,
    };
  }

  if (stops.length > 0) {
    return {
      bounds: unionBounds(
        stops.map((stop) => ({
          x: stop.placeholder?.left ?? stop.x,
          y: stop.top,
          width:
            (stop.placeholder?.right ?? stop.x) -
            (stop.placeholder?.left ?? stop.x),
          height: stop.bottom - stop.top,
        })),
      ),
      baseline: stops[0].y,
    };
  }

  return { bounds: { x: 0, y: 0, width: 0, height: 0 }, baseline: 0 };
}

function sampleArea(sample: BoxSample): number {
  return sample.bounds.width * sample.bounds.height;
}

function unionBounds(
  bounds: readonly MathDocumentBounds[],
): MathDocumentBounds {
  const left = Math.min(...bounds.map((bound) => bound.x));
  const top = Math.min(...bounds.map((bound) => bound.y));
  const right = Math.max(...bounds.map((bound) => bound.x + bound.width));
  const bottom = Math.max(...bounds.map((bound) => bound.y + bound.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function caretGeometryDistance(
  stop: MathDocumentCaretStop,
  rect: { readonly x: number; readonly top: number; readonly bottom: number },
): number {
  return (
    Math.abs(stop.x - rect.x) +
    Math.abs(stop.top - rect.top) +
    Math.abs(stop.bottom - rect.bottom)
  );
}

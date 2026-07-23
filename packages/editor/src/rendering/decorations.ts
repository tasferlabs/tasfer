/**
 * Decorations — the engine's one generic overlay primitive.
 *
 * A decoration is an **ephemeral, externally-supplied, range-anchored overlay**
 * the renderer paints on top of the document without it being document content:
 * it never enters the CRDT, the op log, undo/redo, or `encodeState()`. It is the
 * single concept that find-in-document highlights and remote-peer cursors are
 * both expressed in terms of — the engine itself knows nothing called "search"
 * or "awareness", only decorations.
 *
 * Two shapes, each reusing an existing painter:
 *   - a **range** decoration is a translucent fill over a flat or structured
 *     content span, painted through the same geometry as the local selection;
 *   - a **caret** decoration is a thin caret (optionally with a label flag),
 *     painted via the same `calculateCursorPosition()` the local caret uses.
 *
 * Coordinates are stable flat **block-id + offset** points (the absolute form of
 * a public {@link DocPoint}) or identity-bearing structured {@link ContentPoint}s.
 * Both survive concurrent remote edits until paint time.
 *
 * Decorations live per-instance on {@link UIState.decorations}, keyed by an
 * opaque **layer** string (e.g. `"search"`, `"presence:<peerId>"`) so unrelated
 * producers never clobber each other. The core never branches on the layer name.
 */

import type { Page } from "../serlization/loadPage";
import type { Position, SelectionState } from "../state-types";
import type { ContentPoint, ContentSelection } from "../structured-selection";
import { findBlockIndex } from "../sync/block-lookup";
import { isTextualBlock } from "../sync/block-registry";
import { getVisibleLengthFromRuns } from "../sync/char-runs";

/** A stable point in a block's flat text. */
export interface FlatDecorationPoint {
  readonly block: string;
  readonly offset: number;
}

/** A decoration endpoint may address flat text or extension-owned content. */
export type DecorationPoint = FlatDecorationPoint | ContentPoint;

/** A stable span between two points; structured endpoints share one attachment. */
export interface DecorationRange {
  readonly from: DecorationPoint;
  readonly to: DecorationPoint;
}

/**
 * A translucent fill over a flat or structured span (find highlight, remote
 * selection). The producer supplies the `color`; `gutter` additionally surfaces
 * the span as a marker on the scrollbar track.
 */
export interface RangeDecoration {
  readonly kind: "range";
  readonly range: DecorationRange;
  readonly color: string;
  /** Fill opacity; falls back to the theme's translucent-fill default. */
  readonly opacity?: number;
  /** Also draw a marker for this span on the scrollbar track. */
  readonly gutter?: boolean;
}

/**
 * A glyph drawn next to a caret label, as primitive shapes in a 24×24 viewBox —
 * the convention lucide and most icon sets share, so a producer can pass an icon
 * set's raw geometry straight through. The core is icon-agnostic: it strokes
 * whatever primitives it's handed (in the label's text color, round caps/joins,
 * at the theme's icon stroke width) with no idea what they depict. A host uses
 * this to mark, say, which device a collaborator is on.
 */
export type LabelIconShape =
  | { readonly shape: "path"; readonly d: string }
  | {
      readonly shape: "rect";
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
      readonly rx?: number;
    }
  | {
      readonly shape: "line";
      readonly x1: number;
      readonly y1: number;
      readonly x2: number;
      readonly y2: number;
    };

/**
 * A caret at a point, optionally with a name/avatar flag (remote cursor). The
 * producer supplies the `color`; label chrome (font/padding/radius) comes from
 * the theme's `remoteCursor` tokens.
 */
export interface CaretDecoration {
  readonly kind: "caret";
  readonly point: DecorationPoint;
  readonly color: string;
  readonly label?: {
    readonly text: string;
    readonly avatar?: string | null;
    /** Glyph drawn before the label text, e.g. a device hint. */
    readonly icon?: readonly LabelIconShape[];
  };
}

export type Decoration = RangeDecoration | CaretDecoration;

/** Per-instance decoration store: opaque layer name -> that layer's decorations. */
export type DecorationLayers = Readonly<Record<string, readonly Decoration[]>>;

/** Replace one layer's decorations (empty array removes the layer). */
export function setDecorationLayer(
  layers: DecorationLayers,
  layer: string,
  decorations: readonly Decoration[],
): DecorationLayers {
  if (decorations.length === 0) return removeDecorationLayer(layers, layer);
  return { ...layers, [layer]: decorations };
}

/** Drop one layer entirely. */
export function removeDecorationLayer(
  layers: DecorationLayers,
  layer: string,
): DecorationLayers {
  if (!(layer in layers)) return layers;
  const next = { ...layers };
  delete next[layer];
  return next;
}

/** Iterate every decoration across all layers (layer order is insertion order). */
export function* allDecorations(
  layers: DecorationLayers,
): Iterable<Decoration> {
  for (const layer of Object.keys(layers)) {
    yield* layers[layer];
  }
}

/** True when any layer holds at least one decoration. */
export function hasDecorations(layers: DecorationLayers): boolean {
  for (const layer of Object.keys(layers)) {
    if (layers[layer].length > 0) return true;
  }
  return false;
}

/**
 * Resolve a stable point to its owning live block position. Flat offsets are
 * clamped to the block's current visible length; structured points use offset 0
 * as a carrier while their identity is resolved by the owning node/mark.
 */
export function resolveDecorationPoint(
  point: DecorationPoint,
  page: Page,
): Position | null {
  const blockIndex = findBlockIndex(
    page,
    isContentDecorationPoint(point) ? point.blockId : point.block,
  );
  if (blockIndex === -1) return null;

  const block = page.blocks[blockIndex];
  if (!block || block.deleted) return null;

  let textIndex = isContentDecorationPoint(point) ? 0 : point.offset;
  if (isTextualBlock(block) && block.charRuns) {
    textIndex = Math.min(textIndex, getVisibleLengthFromRuns(block.charRuns));
  } else {
    textIndex = 0;
  }

  return { blockIndex, textIndex: Math.max(0, textIndex) };
}

/**
 * Resolve a {@link RangeDecoration} into the `{ anchor, focus, isForward,
 * isCollapsed }` selection shape `selectionRects()` consumes. Returns `null` if
 * either endpoint's block is gone. The span may cross blocks; `selectionRects`
 * clips it to the block it is painting.
 */
export function rangeDecorationToSelection(
  range: DecorationRange,
  page: Page,
): SelectionState | null {
  if (
    isContentDecorationPoint(range.from) ||
    isContentDecorationPoint(range.to)
  ) {
    return null;
  }
  const anchor = resolveDecorationPoint(range.from, page);
  const focus = resolveDecorationPoint(range.to, page);
  if (!anchor || !focus) return null;

  const isCollapsed =
    anchor.blockIndex === focus.blockIndex &&
    anchor.textIndex === focus.textIndex;

  return { anchor, focus, isForward: true, isCollapsed };
}

/** Whether a decoration endpoint addresses extension-owned structured content. */
export function isContentDecorationPoint(
  point: DecorationPoint,
): point is ContentPoint {
  return "kind" in point && (point.kind === "text" || point.kind === "gap");
}

/** The owning block id for either decoration-point currency. */
export function decorationPointBlockId(point: DecorationPoint): string {
  return isContentDecorationPoint(point) ? point.blockId : point.block;
}

/** Resolve a structured decoration range without flattening its tree identity. */
export function rangeDecorationToContentSelection(
  range: DecorationRange,
): ContentSelection | null {
  if (
    !isContentDecorationPoint(range.from) ||
    !isContentDecorationPoint(range.to) ||
    range.from.blockId !== range.to.blockId ||
    range.from.contentId !== range.to.contentId
  ) {
    return null;
  }
  return { anchor: range.from, focus: range.to };
}

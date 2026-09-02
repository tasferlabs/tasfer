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
 *   - a **range** decoration is a translucent fill — or, via `style`, an
 *     underline stroke — over a flat or structured content span, painted
 *     through the same geometry as the local selection;
 *   - a **caret** decoration is a thin caret (optionally with a label flag),
 *     painted via the same `calculateCursorPosition()` the local caret uses.
 *
 * Coordinates may be flat **block-id + offset** points (the absolute form of a
 * public {@link DocPoint}), CRDT character gaps, or identity-bearing structured
 * {@link ContentPoint}s. Character gaps survive concurrent text edits and are
 * resolved to a live offset at paint time.
 *
 * Decorations live per-instance on {@link UIState.decorations}, keyed by an
 * opaque **layer** string (e.g. `"search"`, `"presence:<peerId>"`) so unrelated
 * producers never clobber each other. The core never branches on the layer name.
 */

import type { Page } from "../serlization/loadPage";
import type { EditorStyles, Position, SelectionState } from "../state-types";
import type { ContentPoint, ContentSelection } from "../structured-selection";
import { findBlockIndex } from "../sync/block-lookup";
import { isTextualBlock } from "../sync/block-registry";
import {
  getVisibleLengthFromRuns,
  getVisibleOffsetAfterChar,
} from "../sync/char-runs";

/** An offset point in a block's flat text. */
export interface FlatDecorationPoint {
  readonly block: string;
  readonly offset: number;
}

/** A CRDT-stable gap in a block's flat text. */
export interface CharacterDecorationPoint {
  readonly blockId: string;
  readonly afterCharId: string | null;
}

/** A decoration endpoint may address flat text or extension-owned content. */
export type DecorationPoint =
  FlatDecorationPoint | CharacterDecorationPoint | ContentPoint;

/** A stable span between two points; structured endpoints share one attachment. */
export interface DecorationRange {
  readonly from: DecorationPoint;
  readonly to: DecorationPoint;
}

/**
 * How a range decoration is painted over its span. `fill` (the default) is the
 * translucent wash the local selection uses; `underline` strokes a line under
 * the text instead, in the decoration's own colour. The core knows only the
 * stroke pattern — what an underline *means* is the producer's business.
 */
export type RangeDecorationStyle =
  | { readonly type: "fill" }
  | {
      readonly type: "underline";
      readonly line: "solid" | "wavy" | "dotted" | "dashed";
      /** Stroke thickness in CSS px; default 1. */
      readonly thickness?: number;
    };

/**
 * A translucent fill (or an underline, see `style`) over a flat or structured
 * span (find highlight, remote selection). The producer supplies the `color`;
 * `gutter` additionally surfaces the span as a marker on the scrollbar track.
 */
export interface RangeDecoration {
  readonly kind: "range";
  readonly range: DecorationRange;
  readonly color: string;
  /**
   * Fill opacity; falls back to the theme's translucent-fill default. An
   * underline defaults to fully opaque instead.
   */
  readonly opacity?: number;
  /** Also draw a marker for this span on the scrollbar track. */
  readonly gutter?: boolean;
  /** How the span is painted; a missing style is a fill. */
  readonly style?: RangeDecorationStyle;
  /**
   * Accessibility semantics for the span. Not painted: the a11y DOM mirror
   * projects the covered text as `<span aria-invalid="…">`, so a screen reader
   * announces it while reading (NVDA says "spelling error", VoiceOver and
   * Narrator say "misspelled"). The tokens are ARIA's own `aria-invalid`
   * vocabulary — the core attaches them to text without knowing what a
   * producer checked for.
   */
  readonly a11y?: { readonly invalid: "spelling" | "grammar" | "true" };
}

/** A fill over one whole block, addressed by its stable document identity. */
export interface BlockDecoration {
  readonly kind: "block";
  readonly block: string;
  readonly color: string;
  /** Fill opacity; falls back to the theme's remote-selection default. */
  readonly opacity?: number;
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

export type Decoration = RangeDecoration | BlockDecoration | CaretDecoration;

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

/** One decoration with its position in the all-layers insertion order. */
interface IndexedDecoration {
  readonly seq: number;
  readonly deco: Decoration;
}

/**
 * Per-block view of a decoration store. `byBlock` holds every decoration that
 * addresses exactly one block; `spanning` holds range decorations whose two
 * endpoints sit on different blocks — those cover every block in between, and
 * only the painter (which knows block order) can tell which, so every lookup
 * includes them. `resolved` memoises the merged per-block answer.
 */
interface BlockDecorationIndex {
  readonly byBlock: Map<string, IndexedDecoration[]>;
  readonly spanning: readonly IndexedDecoration[];
  readonly resolved: Map<string, readonly Decoration[]>;
}

/**
 * Derived per-block index keyed by the exact `DecorationLayers` identity.
 * Layers are replaced immutably (`setDecorationLayer`), so a store and its
 * index are garbage-collected together — the same pattern as the block-id
 * index in `sync/block-lookup.ts`.
 */
const blockDecorationIndexes = new WeakMap<
  DecorationLayers,
  BlockDecorationIndex
>();

const NO_DECORATIONS: readonly Decoration[] = [];

function buildBlockDecorationIndex(
  layers: DecorationLayers,
): BlockDecorationIndex {
  const byBlock = new Map<string, IndexedDecoration[]>();
  const spanning: IndexedDecoration[] = [];
  let seq = 0;
  const add = (blockId: string, entry: IndexedDecoration): void => {
    const bucket = byBlock.get(blockId);
    if (bucket) bucket.push(entry);
    else byBlock.set(blockId, [entry]);
  };
  for (const deco of allDecorations(layers)) {
    const entry = { seq: seq++, deco };
    if (deco.kind === "block") {
      add(deco.block, entry);
    } else if (deco.kind === "caret") {
      add(decorationPointBlockId(deco.point), entry);
    } else {
      const from = decorationPointBlockId(deco.range.from);
      const to = decorationPointBlockId(deco.range.to);
      if (from === to) add(from, entry);
      else spanning.push(entry);
    }
  }
  return { byBlock, spanning, resolved: new Map() };
}

/**
 * The decorations that can touch one block, in all-layers insertion order —
 * everything anchored to `blockId` plus every range that spans blocks (its
 * endpoints sit on other blocks, but it may pass through this one). Painters
 * iterate this instead of {@link allDecorations} so a page carrying thousands
 * of decorations costs each block only its own share. Derived lazily once per
 * `DecorationLayers` identity.
 */
export function decorationsForBlock(
  layers: DecorationLayers,
  blockId: string,
): readonly Decoration[] {
  let index = blockDecorationIndexes.get(layers);
  if (!index) {
    index = buildBlockDecorationIndex(layers);
    blockDecorationIndexes.set(layers, index);
  }
  const cached = index.resolved.get(blockId);
  if (cached) return cached;

  const own = index.byBlock.get(blockId);
  let result: readonly Decoration[];
  if (!own) {
    result =
      index.spanning.length === 0
        ? NO_DECORATIONS
        : index.spanning.map((entry) => entry.deco);
  } else if (index.spanning.length === 0) {
    result = own.map((entry) => entry.deco);
  } else {
    // Merge two seq-sorted lists so layer order survives the split.
    const merged: Decoration[] = [];
    let a = 0;
    let b = 0;
    const { spanning } = index;
    while (a < own.length || b < spanning.length) {
      const takeOwn =
        b >= spanning.length ||
        (a < own.length && own[a].seq < spanning[b].seq);
      merged.push(takeOwn ? own[a++].deco : spanning[b++].deco);
    }
    result = merged;
  }
  index.resolved.set(blockId, result);
  return result;
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
  const blockIndex = findBlockIndex(page, decorationPointBlockId(point));
  if (blockIndex === -1) return null;

  const block = page.blocks[blockIndex];
  if (!block || block.deleted) return null;

  let textIndex = 0;
  if (isTextualBlock(block) && block.charRuns) {
    if (isCharacterDecorationPoint(point)) {
      const resolved = getVisibleOffsetAfterChar(
        block.charRuns,
        point.afterCharId,
      );
      if (resolved === null) return null;
      textIndex = resolved;
    } else if (!isContentDecorationPoint(point)) {
      textIndex = Math.min(
        point.offset,
        getVisibleLengthFromRuns(block.charRuns),
      );
    }
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

/** Whether a flat decoration endpoint is anchored to a CRDT character gap. */
export function isCharacterDecorationPoint(
  point: DecorationPoint,
): point is CharacterDecorationPoint {
  return "afterCharId" in point && !isContentDecorationPoint(point);
}

/** The owning block id for any decoration-point currency. */
export function decorationPointBlockId(point: DecorationPoint): string {
  return isContentDecorationPoint(point) || isCharacterDecorationPoint(point)
    ? point.blockId
    : point.block;
}

/**
 * One painted fragment of a range decoration — a line box, a bidi run, a
 * structured row, or a whole block box. `baseline` is the absolute y of the
 * text baseline the fragment sits on; an underline hangs from it. Fragments
 * without one (a box with no text of its own) underline near the bottom edge.
 */
export interface DecorationRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly baseline?: number;
}

/**
 * The paint channels of a range decoration a painter needs — a whole
 * {@link RangeDecoration} qualifies, as does a bare `{ color, opacity, style }`
 * for a painter reusing the machinery for its own (local) selection.
 */
export type RangeDecorationPaint =
  RangeDecoration | Pick<RangeDecoration, "color" | "opacity" | "style">;

/** Gap between the text baseline and the top of a decoration underline, in CSS px. */
const UNDERLINE_GAP = 3;

/** Stroke thickness of a decoration underline, in CSS px. */
function underlineThickness(deco: RangeDecorationPaint): number {
  return deco.style?.type === "underline" ? (deco.style.thickness ?? 1) : 0;
}

/**
 * A whole-box fragment (image, table cell, equation card) as a
 * {@link DecorationRect}: its fill is the box itself, and an underline hugs the
 * box's bottom edge instead of guessing at a baseline the box does not have.
 */
export function boxDecorationRect(
  box: { x: number; y: number; width: number; height: number },
  deco: RangeDecorationPaint,
): DecorationRect {
  const thickness = underlineThickness(deco);
  return {
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    baseline: box.y + box.height - UNDERLINE_GAP - thickness,
  };
}

/**
 * Paint a range decoration over the fragments a node's selection geometry
 * produced. A fill (the default) is the translucent wash the local selection
 * uses — `color`, `opacity ?? styles.selection.remoteOpacity`, the theme's
 * corner radius. An underline strokes one line per fragment just below the
 * baseline (under a link's own underline, so both stay visible), in `color`,
 * fully opaque unless `opacity` says otherwise. Wavy strokes are phase-locked
 * to absolute x, so the fragments of one span (adjacent bidi runs, a chip
 * beside prose) tile into one continuous wave. Custom nodes call this from
 * `paint` so every style renders in their block too.
 */
export function paintDecorationRects(
  ctx: CanvasRenderingContext2D,
  rects: readonly DecorationRect[],
  deco: RangeDecorationPaint,
  styles: EditorStyles,
): void {
  if (rects.length === 0) return;
  const style = deco.style;
  if (!style || style.type === "fill") {
    const cornerRadius = styles.selection.cornerRadius;
    ctx.save();
    ctx.fillStyle = deco.color;
    ctx.globalAlpha = deco.opacity ?? styles.selection.remoteOpacity;
    for (const r of rects) {
      if (cornerRadius > 0) {
        ctx.beginPath();
        ctx.roundRect(r.x, r.y, r.width, r.height, cornerRadius);
        ctx.fill();
      } else {
        ctx.fillRect(r.x, r.y, r.width, r.height);
      }
    }
    ctx.restore();
    return;
  }

  const thickness = style.thickness ?? 1;
  ctx.save();
  ctx.strokeStyle = deco.color;
  ctx.globalAlpha = deco.opacity ?? 1;
  ctx.lineWidth = thickness;
  ctx.lineCap = "butt";
  ctx.lineJoin = "round";
  if (style.line === "dotted") ctx.setLineDash([thickness, 2 * thickness]);
  else if (style.line === "dashed") {
    ctx.setLineDash([3 * thickness, 2 * thickness]);
  }
  for (const r of rects) {
    if (r.width <= 0) continue;
    const baseline = r.baseline ?? r.y + r.height * 0.8;
    // Centre the stroke on a half pixel so a 1px line stays crisp.
    const y = Math.floor(baseline + UNDERLINE_GAP + thickness / 2) + 0.5;
    const right = r.x + r.width;
    ctx.beginPath();
    if (style.line === "wavy") {
      // Amplitude ≈ thickness, period ≈ 4× thickness. Sampled against absolute
      // x (not the fragment's own left edge) so neighbouring fragments continue
      // the same wave without a seam.
      const amplitude = thickness;
      const period = 4 * thickness;
      const step = period / 8;
      const wave = (px: number): number =>
        y + amplitude * Math.sin((2 * Math.PI * px) / period);
      ctx.moveTo(r.x, wave(r.x));
      for (let px = r.x + step; px < right; px += step) {
        ctx.lineTo(px, wave(px));
      }
      ctx.lineTo(right, wave(right));
    } else {
      ctx.moveTo(r.x, y);
      ctx.lineTo(right, y);
    }
    ctx.stroke();
  }
  ctx.restore();
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

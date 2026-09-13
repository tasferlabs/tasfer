/**
 * DomMirror — the accessible DOM shadow of the canvas document.
 *
 * The editor paints to a canvas, which is opaque to screen readers. This module
 * maintains a hidden but accessibility-tree-VISIBLE DOM tree that mirrors the
 * document's semantic structure (headings, lists, code, marks), so assistive
 * tech can read and navigate it. It is a host-side reading surface, distinct
 * from the contenteditable input surface (`hiddenInput`) the engine uses for
 * keyboard/IME/clipboard.
 *
 * The expensive work — turning a block into markup — is the existing HTML
 * serialization facet (`codec.html.output`), so a block type is accessible for
 * free the moment it serializes; there is no parallel per-node a11y method to
 * keep in sync. Accessibility is a second consumer of the serialization each
 * node already owns, not a new node responsibility.
 *
 * Surgical, not full-rebuild: the CRDT op stream already says exactly which
 * blocks changed (each op carries a stable `blockId`). On a change we
 * re-serialize ONLY those blocks (approach A: whole-block re-render) and patch
 * them in place. Cost is O(ops in the transaction), not O(document) — the diff
 * the document already computed, reused rather than rediscovered by a vdom.
 *
 * The container element is owned by the host (created in `mountEditor`); this
 * class owns only its children. The pure helpers (`affectedBlockIds`,
 * `structureSignature`, `planChildren`, `blockHtml`) carry the diff/grouping
 * decisions and are unit-tested without a DOM; the thin patching glue is
 * covered by the web build and browser checks (canvas/DOM chrome).
 */

import { getBaseDataSchema } from "../baseDataSchema";
import {
  type Decoration,
  type DecorationLayers,
  decorationPointBlockId,
  decorationsForBlock,
  isContentDecorationPoint,
  type RangeDecoration,
  resolveDecorationPoint,
} from "../rendering/decorations";
import type { OutputCtx } from "../serlization/codecs";
import { inlineToHtml } from "../serlization/codecs/inline";
import type { Block, Page } from "../serlization/loadPage";
import type { Operation } from "../state-types";
import { findBlockIndex } from "../sync/block-lookup";
import { isTextualBlock } from "../sync/block-registry";
import { getVisibleLengthFromRuns } from "../sync/char-runs";
import type { DataSchema } from "../sync/schema";

/** The block ids touched by a change transaction — the set to re-serialize. */
export function affectedBlockIds(ops: readonly Operation[]): Set<string> {
  const ids = new Set<string>();
  for (const op of ops) ids.add(op.blockId);
  return ids;
}

/**
 * A cheap fingerprint of the document's *structure* — block identity, order,
 * and type. When it is unchanged between two transactions, a change is
 * content-only and each dirty block is patched in place; when it differs (a
 * block inserted/deleted/reordered/retyped, which can change list grouping) the
 * container's child structure is rebuilt, reusing cached elements.
 */
export function structureSignature(blocks: readonly Block[]): string {
  let sig = "";
  for (const b of blocks) sig += `${b.id}:${b.type}|`;
  return sig;
}

/**
 * A child node of the mirror is either a standalone block element or a list
 * group wrapping consecutive same-kind list items under one `<ul>`/`<ol>`
 * (screen readers announce a list and its item count). Indentation is conveyed
 * with `aria-level` on the item rather than physical nesting — valid, supported,
 * and far simpler than nested containers for a first cut.
 */
export type ChildPlan =
  | { kind: "block"; id: string }
  | { kind: "list"; tag: "ul" | "ol"; todo: boolean; itemIds: string[] };

/** Group an ordered block list into standalone blocks and list runs. Pure. */
export function planChildren(
  blocks: readonly Block[],
  schema: DataSchema,
): ChildPlan[] {
  const plan: ChildPlan[] = [];
  let current: Extract<ChildPlan, { kind: "list" }> | null = null;
  for (const b of blocks) {
    const listKind = schema.listKind(b.type);
    if (listKind) {
      const tag = listKind === "numbered" ? "ol" : "ul";
      const todo = listKind === "todo";
      if (!current || current.tag !== tag || current.todo !== todo) {
        current = { kind: "list", tag, todo, itemIds: [] };
        plan.push(current);
      }
      current.itemIds.push(b.id);
    } else {
      current = null;
      plan.push({ kind: "block", id: b.id });
    }
  }
  return plan;
}

/**
 * Serialize one block to its semantic HTML, reusing the node's own HTML codec.
 * `preferSource` makes math emit its LaTeX source (readable text) rather than an
 * SVG image the screen reader cannot see; no MathJax renderer is needed, so none
 * is passed.
 */
export function blockHtml(
  block: Block,
  schema: DataSchema,
  ctx?: OutputCtx,
): string {
  const codec = schema.getCodec(block.type);
  if (!codec) return "";
  const resolved = makeOutputCtx(schema, block);
  return codec.html.output(
    block,
    ctx ? { ...ctx, inline: resolved.inline } : resolved,
  );
}

function makeOutputCtx(schema: DataSchema, block?: Block): OutputCtx {
  return {
    format: "html",
    inline: (charRuns, formats) =>
      inlineToHtml(
        charRuns,
        formats,
        schema,
        undefined,
        true,
        block?.structuredContent,
      ),
    mapAssetUrl: (url) => url,
    preferSource: true,
  };
}

function indentOf(block: Block): number {
  return "indent" in block ? (block as { indent?: number }).indent || 0 : 0;
}

const NO_LAYERS: DecorationLayers = {};

// -----------------------------------------------------------------------------
// Range decorations → ARIA
//
// A range decoration may carry `a11y.invalid`; the mirror projects it onto the
// covered text as `<span aria-invalid="…">`. Everything below is pure and
// DOM-free until `wrapInvalidRanges`, which is the only piece that touches
// nodes — and it walks `childNodes` recursively (no TreeWalker) so a fake
// tree can exercise it in tests.
// -----------------------------------------------------------------------------

/** An `aria-invalid` token a range decoration may declare. */
export type AriaInvalidToken = NonNullable<RangeDecoration["a11y"]>["invalid"];

/** A flat `[from, to)` span of one block's visible text carrying a token. */
export interface InvalidRange {
  readonly from: number;
  readonly to: number;
  readonly invalid: AriaInvalidToken;
}

/**
 * One slice of a mirrored text node after splitting: `[start, end)` within the
 * node's own text, and the token wrapping it (`null` for untouched text).
 */
export interface InvalidSegment {
  readonly start: number;
  readonly end: number;
  readonly invalid: AriaInvalidToken | null;
}

/**
 * The block ids any of the given decoration lists touch — the set to re-render
 * when a layer is replaced (old contents ∪ new contents). A range that spans
 * blocks contributes its two endpoints; the blocks in between are picked up on
 * their next render, which reads the same store.
 */
export function decorationBlockIds(
  ...groups: readonly (readonly Decoration[] | undefined)[]
): Set<string> {
  const ids = new Set<string>();
  for (const group of groups) {
    if (!group) continue;
    for (const deco of group) {
      if (deco.kind === "block") ids.add(deco.block);
      else if (deco.kind === "caret")
        ids.add(decorationPointBlockId(deco.point));
      else {
        ids.add(decorationPointBlockId(deco.range.from));
        ids.add(decorationPointBlockId(deco.range.to));
      }
    }
  }
  return ids;
}

/**
 * The `a11y`-carrying range decorations that cover `block`, as flat visible
 * offsets clipped to the block, in all-layers insertion order. Structured
 * (`ContentPoint`) ranges have no flat text to wrap and are skipped, as are
 * ranges whose endpoints no longer resolve. `visibleLength` clips a span that
 * runs past the block.
 */
export function invalidRangesForBlock(
  layers: DecorationLayers,
  page: Page,
  block: Block,
  visibleLength: number,
): InvalidRange[] {
  const ranges: InvalidRange[] = [];
  const decos = decorationsForBlock(layers, block.id);
  if (decos.length === 0) return ranges;
  const blockIndex = findBlockIndex(page, block.id);
  if (blockIndex === -1) return ranges;

  for (const deco of decos) {
    if (deco.kind !== "range" || !deco.a11y) continue;
    const { from, to } = deco.range;
    if (isContentDecorationPoint(from) || isContentDecorationPoint(to)) {
      continue;
    }
    const anchor = resolveDecorationPoint(from, page);
    const focus = resolveDecorationPoint(to, page);
    if (!anchor || !focus) continue;
    if (anchor.blockIndex > blockIndex || focus.blockIndex < blockIndex) {
      continue;
    }
    const start = anchor.blockIndex < blockIndex ? 0 : anchor.textIndex;
    const end =
      focus.blockIndex > blockIndex
        ? visibleLength
        : Math.min(focus.textIndex, visibleLength);
    if (start < end)
      ranges.push({ from: start, to: end, invalid: deco.a11y.invalid });
  }
  return ranges;
}

/**
 * Plan how each text node splits so every range boundary lands on a node edge.
 * `lengths` are the text nodes' lengths in document order (their concatenation
 * is the block's visible text); `ranges` are flat spans over that text. Returns
 * one ordered segment list per node covering `[0, length)`. Where ranges
 * overlap, the later one (higher layer insertion order) wins, mirroring paint
 * order. Pure and deterministic.
 */
export function planInvalidSegments(
  lengths: readonly number[],
  ranges: readonly InvalidRange[],
): InvalidSegment[][] {
  const plan: InvalidSegment[][] = [];
  let base = 0;
  for (const length of lengths) {
    const nodeEnd = base + length;
    const cuts = new Set<number>([0, length]);
    const hits: InvalidRange[] = [];
    for (const range of ranges) {
      if (range.from >= range.to) continue;
      if (range.to <= base || range.from >= nodeEnd) continue;
      hits.push(range);
      cuts.add(Math.max(0, range.from - base));
      cuts.add(Math.min(length, range.to - base));
    }
    const sorted = [...cuts].sort((a, b) => a - b);
    const segments: InvalidSegment[] = [];
    for (let i = 0; i + 1 < sorted.length; i++) {
      const start = sorted[i];
      const end = sorted[i + 1];
      let invalid: AriaInvalidToken | null = null;
      for (const range of hits) {
        if (range.from <= base + start && range.to >= base + end) {
          invalid = range.invalid;
        }
      }
      segments.push({ start, end, invalid });
    }
    if (segments.length === 0)
      segments.push({ start: 0, end: 0, invalid: null });
    plan.push(segments);
    base = nodeEnd;
  }
  return plan;
}

/** Depth-first text nodes under `root`, in document order (no TreeWalker). */
export function collectTextNodes(root: Node): Text[] {
  const out: Text[] = [];
  const visit = (node: Node): void => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 3) out.push(child as Text);
      else visit(child);
    }
  };
  visit(root);
  return out;
}

/**
 * Wrap the parts of `root`'s text covered by `ranges` in `<span aria-invalid>`.
 * Offsets are visible UTF-16 offsets into the block's text, so they only mean
 * something if the mirror's text nodes concatenate to exactly that text: when
 * their total length differs from `expectedLength` (a `<br>` for a soft break,
 * a replacement run, an entity the serializer expanded) alignment is lost and
 * the pass is skipped rather than risk wrapping the wrong letters. Returns
 * whether it ran.
 */
export function wrapInvalidRanges(
  root: Node,
  ranges: readonly InvalidRange[],
  expectedLength: number,
  doc: Document,
): boolean {
  if (ranges.length === 0) return true;
  const textNodes = collectTextNodes(root);
  const lengths = textNodes.map((node) => node.data.length);
  let total = 0;
  for (const length of lengths) total += length;
  if (total !== expectedLength) return false;

  const plan = planInvalidSegments(lengths, ranges);
  for (let i = 0; i < textNodes.length; i++) {
    const segments = plan[i];
    if (segments.length === 1 && segments[0].invalid === null) continue;
    const node = textNodes[i];
    const parent = node.parentNode;
    if (!parent) continue;
    const text = node.data;
    for (const segment of segments) {
      if (segment.start === segment.end) continue;
      const piece = doc.createTextNode(text.slice(segment.start, segment.end));
      if (segment.invalid === null) {
        parent.insertBefore(piece, node);
      } else {
        const span = doc.createElement("span");
        span.setAttribute("aria-invalid", segment.invalid);
        span.appendChild(piece);
        parent.insertBefore(span, node);
      }
    }
    parent.removeChild(node);
  }
  return true;
}

export interface DomMirrorOptions {
  /** Host-owned container; the mirror owns only its children, never the node. */
  readonly container: HTMLElement;
  /** Reads the document's current blocks in order (may include tombstones). */
  readonly getBlocks: () => readonly Block[];
  /**
   * Reads the current decoration store; range decorations carrying `a11y` are
   * projected as `aria-invalid` on the mirrored text. Defaults to none.
   */
  readonly getDecorations?: () => DecorationLayers;
  /** Serialization schema (codecs + list grouping). Defaults to the base set. */
  readonly schema?: DataSchema;
  /** Injectable for tests; defaults to the ambient `document`. */
  readonly doc?: Document;
}

export class DomMirror {
  private readonly container: HTMLElement;
  private readonly getBlocks: () => readonly Block[];
  private readonly getDecorations: () => DecorationLayers;
  private readonly schema: DataSchema;
  private readonly doc: Document;
  private readonly win: Window | null;
  /** blockId → its rendered block element (the `<p>`/`<h1>`/`<li>`/…). */
  private readonly els = new Map<string, HTMLElement>();
  /** listKey → its `<ul>`/`<ol>` wrapper, reused across flushes (see listKey). */
  private readonly lists = new Map<string, HTMLElement>();
  private readonly outputCtx: OutputCtx;
  private sig = "";
  private destroyed = false;
  /**
   * Block ids whose content changed since the last flush, accumulated across
   * coalesced change transactions. The mirror is a background reading surface,
   * so it never updates on the synchronous edit path — a large paste must not
   * pay an O(document) DOM rebuild inside the keystroke/paste handler.
   */
  private pendingDirty = new Set<string>();
  private rafId: number | null = null;

  constructor(options: DomMirrorOptions) {
    this.container = options.container;
    this.getBlocks = options.getBlocks;
    this.getDecorations = options.getDecorations ?? (() => NO_LAYERS);
    this.schema = options.schema ?? getBaseDataSchema();
    this.doc = options.doc ?? globalThis.document;
    this.win = this.doc.defaultView ?? null;
    this.outputCtx = makeOutputCtx(this.schema);
    this.rebuild();
  }

  /**
   * Note a change transaction's touched blocks and schedule a coalesced flush.
   * Returns immediately — the DOM work happens off the critical path on the next
   * animation frame, batching a burst of edits (a paste, fast typing) into one
   * update. Screen readers tolerate a frame of latency; the editor must not.
   */
  applyChange(ops: readonly Operation[]): void {
    if (this.destroyed) return;
    for (const op of ops) this.pendingDirty.add(op.blockId);
    this.scheduleFlush();
  }

  /**
   * Note that the decorations touching `blockIds` changed and schedule the same
   * coalesced flush as {@link applyChange}. The blocks are re-rendered from
   * scratch, so a decoration whose `a11y` was removed simply stops appearing.
   */
  applyDecorations(blockIds: Iterable<string>): void {
    if (this.destroyed) return;
    for (const id of blockIds) this.pendingDirty.add(id);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.rafId !== null || this.destroyed) return;
    const raf = this.win?.requestAnimationFrame;
    if (raf) {
      this.rafId = raf.call(this.win, () => {
        this.rafId = null;
        this.flush();
      });
    } else {
      // No frame scheduler (non-browser host): apply synchronously.
      this.flush();
    }
  }

  /** Reconcile the mirror to the current document, re-serializing dirty blocks. */
  private flush(): void {
    if (this.destroyed) return;
    const dirty = this.pendingDirty;
    this.pendingDirty = new Set();

    const blocks = this.live();
    const newSig = structureSignature(blocks);
    const structural = newSig !== this.sig;

    // Re-serialize only the touched (or newly seen) blocks. When the structure
    // is unchanged, splice each fresh element in place; otherwise the rebuild
    // below repositions every element, so an in-place swap would be wasted.
    for (const block of blocks) {
      if (!dirty.has(block.id) && this.els.has(block.id)) continue;
      const fresh = this.renderBlockEl(block);
      const old = this.els.get(block.id);
      this.els.set(block.id, fresh);
      if (!structural && old?.parentNode) old.replaceWith(fresh);
    }

    if (structural) {
      this.mountChildren(blocks);
      this.sig = newSig;
    }
    this.prune(blocks);
  }

  /** Rebuild the whole mirror from scratch — e.g. after a full document load. */
  rebuild(): void {
    if (this.destroyed) return;
    this.cancelFlush();
    this.pendingDirty.clear();
    const blocks = this.live();
    this.els.clear();
    this.lists.clear();
    for (const block of blocks)
      this.els.set(block.id, this.renderBlockEl(block));
    this.mountChildren(blocks);
    this.sig = structureSignature(blocks);
  }

  destroy(): void {
    this.destroyed = true;
    this.cancelFlush();
    this.els.clear();
    this.lists.clear();
    while (this.container.firstChild) {
      this.container.removeChild(this.container.firstChild);
    }
  }

  private cancelFlush(): void {
    if (this.rafId !== null) {
      this.win?.cancelAnimationFrame?.(this.rafId);
      this.rafId = null;
    }
  }

  private live(): Block[] {
    return this.getBlocks().filter((b) => !b.deleted);
  }

  private renderBlockEl(block: Block): HTMLElement {
    const template = this.doc.createElement("template");
    template.innerHTML = blockHtml(block, this.schema, this.outputCtx);
    const el =
      (template.content.firstElementChild as HTMLElement | null) ??
      this.doc.createElement("p");
    el.setAttribute("data-block-id", block.id);
    const indent = indentOf(block);
    if (indent > 0 && el.tagName === "LI") {
      el.setAttribute("aria-level", String(indent + 1));
    }
    this.projectInvalidRanges(el, block);
    return el;
  }

  /**
   * Post-pass over a freshly rendered block: wrap the text its `a11y` range
   * decorations cover in `<span aria-invalid>`. Only textual blocks have flat
   * offsets to map; a misaligned block (see `wrapInvalidRanges`) is left as is.
   */
  private projectInvalidRanges(el: HTMLElement, block: Block): void {
    if (!isTextualBlock(block) || !block.charRuns) return;
    const layers = this.getDecorations();
    const blocks = this.getBlocks();
    const page: Page = { id: "", title: "", blocks: blocks as Block[] };
    const visibleLength = getVisibleLengthFromRuns(block.charRuns);
    const ranges = invalidRangesForBlock(layers, page, block, visibleLength);
    if (ranges.length === 0) return;
    wrapInvalidRanges(el, ranges, visibleLength, this.doc);
  }

  /**
   * Stable identity for a list group so its `<ul>`/`<ol>` wrapper survives
   * across structural flushes. Keyed by kind plus the group's lead item: while
   * the lead is unchanged (the common case — append/edit inside a list) the same
   * wrapper is reused and only its changed items move, so the browser never
   * re-lays-out the whole list.
   */
  private static listKey(node: Extract<ChildPlan, { kind: "list" }>): string {
    return `${node.tag}:${node.todo ? "t" : ""}:${node.itemIds[0]}`;
  }

  /**
   * Patch `parent`'s children to exactly `desired`, in order, moving the fewest
   * nodes possible. Nodes already in the right place are left untouched — this is
   * the whole point of a surgical mirror: re-parenting a node invalidates its
   * layout, so a one-block edit must not detach a document's worth of unchanged
   * nodes (which is what an append-a-fresh-fragment rebuild does, and what showed
   * up as multi-second "Layout").
   */
  private static reconcileChildren(
    parent: Node,
    desired: readonly Node[],
  ): void {
    const keep = new Set<Node>(desired);
    for (const child of [...parent.childNodes]) {
      if (!keep.has(child)) parent.removeChild(child);
    }
    let ref = parent.firstChild;
    for (const el of desired) {
      if (ref === el) {
        ref = ref.nextSibling;
        continue;
      }
      // insertBefore moves `el` if it is already attached elsewhere; in-order
      // survivors hit the fast path above and are never touched.
      parent.insertBefore(el, ref);
    }
  }

  /** Reconcile the container's children to the current block plan, in place. */
  private mountChildren(blocks: Block[]): void {
    const desired: HTMLElement[] = [];
    const usedLists = new Set<string>();
    for (const node of planChildren(blocks, this.schema)) {
      if (node.kind === "block") {
        const el = this.els.get(node.id);
        if (el) desired.push(el);
        continue;
      }
      const key = DomMirror.listKey(node);
      usedLists.add(key);
      let list = this.lists.get(key);
      if (!list) {
        list = this.doc.createElement(node.tag);
        list.setAttribute("role", "list");
        this.lists.set(key, list);
      }
      list.className = node.todo ? "todo" : "";
      const items: HTMLElement[] = [];
      for (const id of node.itemIds) {
        const el = this.els.get(id);
        if (el) items.push(el);
      }
      DomMirror.reconcileChildren(list, items);
      desired.push(list);
    }
    for (const key of [...this.lists.keys()]) {
      if (!usedLists.has(key)) this.lists.delete(key);
    }
    DomMirror.reconcileChildren(this.container, desired);
  }

  private prune(blocks: Block[]): void {
    const present = new Set(blocks.map((b) => b.id));
    for (const id of [...this.els.keys()]) {
      if (!present.has(id)) this.els.delete(id);
    }
  }
}

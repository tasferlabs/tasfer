/**
 * normalizeBlocks — coerce a block sequence to a schema's authoring allow-list
 * and to its `content` shape expression.
 *
 * Applied to blocks arriving from OUTSIDE the local authoring paths — paste and
 * non-synced import (see `loadPage` and clipboard `insertBlocksAtCursor`). It is
 * the paste/import analogue of ProseMirror normalizing content against its schema
 * during parse: a block type the schema forbids is coerced to a plain block
 * (preserving its text) or dropped, and disallowed inline marks are stripped.
 *
 * Purely a function of `(blocks, schema)` — no ids are minted, no randomness — so
 * two peers normalizing the same input converge. It is a strict no-op for an
 * UNRESTRICTED schema (the default body editor), so wiring it in never changes
 * behavior until a caller restricts a schema.
 *
 * It does NOT guarantee a non-empty result: paste of only-disallowed content
 * yields nothing (insert nothing), which is correct for a partial insert. The
 * whole-document non-empty invariant is the caller's (loadPage) concern — as is
 * FILLING a shape's missing tail, which needs fresh ids this function may not
 * mint.
 */

import type { ContentMatch } from "../sync/content-expression";
import type { DataSchema } from "../sync/schema";
import type { Block, CustomBlock, MarkSpan } from "./loadPage";

/** The marks on a block that survive the schema's mark allow-list. */
function allowedFormats(
  formats: readonly MarkSpan[] | undefined,
  schema: DataSchema,
): MarkSpan[] {
  if (!formats) return [];
  return formats.filter((span) => schema.isMarkAllowed(span.format.type));
}

/** An allowed block with any disallowed inline marks stripped (same object when unchanged). */
function withAllowedFormats(block: Block, schema: DataSchema): Block {
  const custom = block as CustomBlock;
  // A non-text block carries no `formats`; nothing to filter.
  if (custom.formats === undefined) return block;
  const filtered = allowedFormats(custom.formats, schema);
  if (filtered.length === custom.formats.length) return block;
  return { ...custom, formats: filtered } as unknown as Block;
}

/**
 * Coerce a disallowed text-bearing block to `target`, preserving its id,
 * orderKey, and text (charRuns) while dropping type-specific fields (list indent,
 * code language, math source flags, …). Returns undefined when the target can't
 * be built (should not happen — restrict() keeps the fallback registered).
 */
function coerceToType(
  block: Block,
  target: string,
  schema: DataSchema,
): Block | undefined {
  const custom = block as CustomBlock;
  const base = schema.createDefaultBlock(
    target,
    custom.id,
    custom.orderKey ?? "",
  );
  if (!base) return undefined;
  return {
    ...(base as CustomBlock),
    charRuns: custom.charRuns ?? [],
    formats: allowedFormats(custom.formats, schema),
  } as unknown as Block;
}

/**
 * Coerce `blocks` to `schema`'s authoring allow-list. Per block:
 *  1. allowed → kept (disallowed inline marks stripped);
 *  2. disallowed but text-bearing and morph-compatible with the fallback
 *     (paragraph/heading/quote/list/math share the "text" morph group) → coerced
 *     to the fallback, text preserved;
 *  3. otherwise (image, line, code, custom void) → dropped.
 *
 * Then, when the schema carries a `content` expression, the surviving sequence
 * is walked against it — see {@link ContentSurroundings} for how a mid-document
 * paste is judged in place rather than as a whole document.
 */
/**
 * Where the normalized blocks land, for the `content` shape pass: the visible
 * block types already before them, and those already after. Both empty (the
 * default) means "this IS the whole document", which is what import passes.
 */
export interface ContentSurroundings {
  readonly before: readonly string[];
  readonly after: readonly string[];
}

export function normalizeBlocks(
  blocks: readonly Block[],
  schema: DataSchema,
  surroundings: ContentSurroundings = { before: [], after: [] },
): Block[] {
  // A schema with no allow-list and no shape rule imposes no authoring
  // constraint — return the input untouched so the unrestricted body editor is
  // entirely unaffected.
  if (
    schema.allowedBlocks === undefined &&
    schema.allowedMarks === undefined &&
    schema.content === undefined
  ) {
    return [...blocks];
  }

  const fallback = schema.fallbackBlockType();
  const canUseFallback = schema.isBlockAllowed(fallback);
  const out: Block[] = [];
  for (const block of blocks) {
    if (schema.isBlockAllowed(block.type)) {
      out.push(withAllowedFormats(block, schema));
      continue;
    }
    if (canUseFallback && schema.canMorphTo(block.type, fallback)) {
      const coerced = coerceToType(block, fallback, schema);
      if (coerced) out.push(coerced);
    }
    // Non-coercible disallowed block (no salvageable inline content) → dropped.
  }
  return coerceToContent(out, schema, surroundings);
}

/**
 * Coerce a block sequence to the schema's `content` expression (a no-op when
 * there is none). Walks the compiled matcher greedily — the matcher is a DFA, so
 * a greedy walk is exact — and per block either keeps it, morphs it to a type
 * the shape accepts at that position (id and text preserved), or drops it.
 *
 * Deliberately does NOT fill a missing tail: that needs fresh block ids, and
 * this function is contractually id-free so two peers normalizing the same input
 * converge. `loadPage` — which already mints — appends `schema.contentFill(...)`
 * for a whole document.
 */
function coerceToContent(
  blocks: readonly Block[],
  schema: DataSchema,
  { before, after }: ContentSurroundings,
): Block[] {
  const content = schema.content;
  if (!content) return [...blocks];

  // Start where the surrounding document leaves the matcher. An unreachable
  // prefix means the document already violates its own shape (synced from a
  // looser peer); tightening the incoming blocks would not repair that, so pass
  // them through rather than mangling a paste over it.
  const start = content.match.matchSequence(before);
  if (!start) return [...blocks];
  let match: ContentMatch = start;

  const out: Block[] = [];
  const kept: string[] = [];
  for (const block of blocks) {
    const next = match.matchType(block.type);
    if (next) {
      out.push(block);
      kept.push(block.type);
      match = next;
      continue;
    }
    // Not admissible here. Salvage the block's text into the first shape-legal
    // type it can morph into; if none can hold it, drop it.
    const target = match
      .allowedTypes()
      .find(
        (candidate) =>
          schema.isBlockAllowed(candidate) &&
          schema.canMorphTo(block.type, candidate),
      );
    if (target === undefined) continue;
    const coerced = coerceToType(block, target, schema);
    if (!coerced) continue;
    out.push(coerced);
    kept.push(target);
    match = match.matchType(target) ?? match;
  }

  // The blocks already AFTER the insertion point still have to fit. Drop from
  // the tail of what was kept until they do — a mid-document paste may simply
  // have no room left. (No-op for import, where `after` is empty.)
  while (
    out.length > 0 &&
    content.match.matchSequence([...before, ...kept, ...after]) === null
  ) {
    out.pop();
    kept.pop();
  }
  return out;
}

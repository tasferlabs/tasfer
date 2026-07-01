/**
 * normalizeBlocks — coerce a block sequence to a schema's authoring allow-list.
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
 * whole-document non-empty invariant is the caller's (loadPage) concern.
 */

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
 * Coerce a disallowed text-bearing block to the fallback type, preserving its id,
 * orderKey, and text (charRuns) while dropping type-specific fields (list indent,
 * code language, math source flags, …). Returns undefined when the fallback can't
 * be built (should not happen — restrict() keeps the fallback registered).
 */
function coerceToFallback(
  block: Block,
  fallback: string,
  schema: DataSchema,
): Block | undefined {
  const custom = block as CustomBlock;
  const base = schema.createDefaultBlock(
    fallback,
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
 */
export function normalizeBlocks(
  blocks: readonly Block[],
  schema: DataSchema,
): Block[] {
  // A schema with no allow-list imposes no authoring constraint — return the
  // input untouched so the unrestricted body editor is entirely unaffected.
  if (schema.allowedBlocks === undefined && schema.allowedMarks === undefined) {
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
      const coerced = coerceToFallback(block, fallback, schema);
      if (coerced) out.push(coerced);
    }
    // Non-coercible disallowed block (no salvageable inline content) → dropped.
  }
  return out;
}

/**
 * baseDataSchema — the default canvas-free document schema, assembled from the
 * built-in node instances.
 *
 * Each block type's serialization now lives as methods on its node (so a block's
 * rendering and round-trip share one file). `codecFromNode` adapts each node
 * into the BlockCodec the parser/serializers consume, paired with the type's
 * CRDT descriptor from BLOCK_REGISTRY. Deriving the schema from the node
 * instances — rather than a hand-maintained static codec table — is what makes
 * each node the single source of truth for its codec, and lets the low-level
 * `DataSchema` class (sync/schema) stay free of any codec/node import (so the
 * build never cycles through the nodes at module-init).
 */

import { defaultNodes } from "./rendering/nodes";
import { codecFromNode } from "./serlization/codecs/from-node";
import { BUILTIN_MARK_CODECS } from "./serlization/codecs/mark-codec";
import type { Block } from "./serlization/loadPage";
import { BLOCK_REGISTRY } from "./sync/block-registry";
import {
  type BlockSpecCore,
  BUILTIN_MARK_TYPES,
  DataSchema,
  type MarkSpec,
} from "./sync/schema";

/** Pair each built-in node's codec (adapted from its methods) with its descriptor. */
function buildBaseBlockSpecs(): BlockSpecCore[] {
  const specs: BlockSpecCore[] = [];
  for (const node of defaultNodes()) {
    const codec = codecFromNode(node);
    // A node may back a family of types (TextNode → headings + paragraph); each
    // member carries its own descriptor but shares the one codec.
    for (const type of node.types ?? [node.type]) {
      const descriptor = BLOCK_REGISTRY[type as keyof typeof BLOCK_REGISTRY];
      if (!descriptor) continue;
      specs.push({ type, descriptor, codec });
    }
  }
  return specs;
}

/**
 * The default schema: every built-in block and mark type. Immutable — derive
 * variants with `baseDataSchema.extend(...)`, never mutate this.
 */
export const baseDataSchema: DataSchema = new DataSchema(
  buildBaseBlockSpecs(),
  BUILTIN_MARK_TYPES.map(
    (type): MarkSpec => ({ type, codec: BUILTIN_MARK_CODECS[type] }),
  ),
);

/**
 * Collect every asset reference owned by the given blocks (deleted blocks
 * skipped), deduplicated in document order. Each block type's `assetRefs` lives
 * on its node; this looks it up through the schema, so a new block type's refs
 * are picked up with no caller changes.
 */
export function collectAssetRefs(blocks: Block[]): string[] {
  const seen = new Set<string>();
  const refs: string[] = [];
  for (const block of blocks) {
    if (block.deleted) continue;
    const codec = baseDataSchema.getCodec(block.type);
    if (!codec?.assetRefs) continue;
    for (const ref of codec.assetRefs(block)) {
      if (!ref || seen.has(ref)) continue;
      seen.add(ref);
      refs.push(ref);
    }
  }
  return refs;
}

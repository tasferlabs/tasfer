/**
 * Adapt a node's {@link NodeCodec} into a {@link BlockCodec}.
 *
 * A block type owns its markdown/HTML/text round-trip as the single `codec`
 * object on its node class (so rendering and serialization live in one file),
 * but the parser/serializers consume a `BlockCodec` — the same shape plus the
 * block-type `types` the codec deliberately omits. This is the seam: it injects
 * the node's identity into its codec, so the orchestrators never import a canvas
 * Node.
 *
 * This module is canvas-free — it only reads `type`/`types`/`codec` via a
 * structural interface. The canvas dependency enters only where a real node
 * instance is passed in.
 */

import type { BlockCodec, NodeCodec } from "./types";
import { invariant } from "@shared/invariant";

/** The serialization slice of a Node — just what {@link codecFromNode} reads. */
export interface SerializableNode {
  readonly type: string;
  readonly types?: readonly string[];
  readonly codec?: NodeCodec;
}

/** Build the {@link BlockCodec} for a node by injecting its `types` into its codec. */
export function codecFromNode(node: SerializableNode): BlockCodec {
  invariant(
    node.codec,
    'Block type "%s" has no codec but was adapted as a serializing node. Declare a `codec` on the node.',
    node.type,
  );
  return { ...node.codec, types: node.types ?? [node.type] };
}

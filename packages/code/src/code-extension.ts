/**
 * Opt-in code-block feature bundle.
 *
 * Unlike math, the `code` *type* is core: `@tasfer/editor` already tokenizes
 * ``` fences, describes the CRDT shape (`BLOCK_REGISTRY.code`) and owns the
 * Markdown/HTML/text round-trip, so a document containing code parses, syncs and
 * serializes with the base schema alone. What this package adds is the *painter*
 * — canvas layout, editing behavior and syntax highlighting — which is what
 * carries the highlight.js grammar set. Compose it into a schema:
 *
 *   const schema = baseSchema.use(codeExtension());
 *
 * Without it a code block still round-trips; it simply renders as an
 * `UnknownNode` placeholder, the same "preserve and degrade" contract as any
 * unregistered block type.
 */

import { CodeNode } from "./CodeNode";
import { codeBlockSpec } from "@tasfer/editor/nodes/code-block";
import type { BlockSpec } from "@tasfer/editor/schema";

export type CodeFeatureExtension = {
  readonly name: "code";
  readonly nodes: readonly [BlockSpec<"code">];
};

/** Build a fresh, instance-safe code feature bundle. */
export function codeExtension(): CodeFeatureExtension {
  return {
    name: "code",
    nodes: [{ ...codeBlockSpec, node: new CodeNode() }],
  };
}

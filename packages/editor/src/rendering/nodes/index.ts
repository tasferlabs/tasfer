/**
 * Node registry wiring.
 *
 * A `NodeRegistry` is per-editor-instance (created at mount, stored on
 * `EditorState.nodes`) — not a module global. Hosts compose the set of
 * nodes they want: pass a custom `nodes` list to `mountEditor` to
 * opt in/out of block types, or use `createDefaultNodeRegistry()` for the
 * built-in set.
 *
 * Two low-level primitives back everything: `TextNode` (text geometry: wrap,
 * caret, selection, hit-test) and `AtomicNode` (intrinsic-sized void/embed
 * boxes). Styled block types extend one of them — see ListNode extending
 * TextNode — and share the same layout/paint/hit-test API.
 */

import { ImageNode } from "./ImageNode";
import { LineNode } from "./LineNode";
import { listNode } from "./ListNode";
import { MathNode } from "./MathNode";
import { Node, NodeRegistry } from "./Node";
import { textNode } from "./TextNode";

export { AtomicNode } from "./AtomicNode";
export { ImageNode } from "./ImageNode";
export { LineNode } from "./LineNode";
export { LIST_BLOCK_TYPES, ListNode, listNode } from "./ListNode";
export { MathNode } from "./MathNode";
export {
  Node,
  type NodeLayout,
  type NodeLayoutCtx,
  type NodePaintCtx,
  NodeRegistry,
  type Point,
} from "./Node";
export {
  getContentWithComposition,
  TEXT_BLOCK_TYPES,
  TextNode,
  textNode,
  type TextNodeLayout,
} from "./TextNode";

/**
 * Shared singleton instances of the stateless built-in nodes, so hosts can
 * compose a custom `nodes` list without constructing them by hand. (Nodes
 * hold no per-editor state — only layout/paint logic — so sharing instances
 * across editors is safe.)
 */
export const lineNode = new LineNode();
export const imageNode = new ImageNode();
export const mathNode = new MathNode();

/**
 * The built-in nodes. Constructed lazily (inside the factory) so importing
 * this module has no side effects and no module-init ordering hazards.
 *
 * `textNode` backs headings + paragraph; `listNode` (a subclass) backs
 * the bullet/numbered/todo family. They register under disjoint type keys, so a
 * host can drop list support entirely by omitting `listNode` from a custom
 * `nodes` list passed to `mountEditor`.
 */
function defaultNodes(): Node[] {
  return [lineNode, imageNode, mathNode, textNode, listNode];
}

/** Build a registry from an explicit list of nodes (host opt-in). */
export function createNodeRegistry(nodes: readonly Node[]): NodeRegistry {
  const registry = new NodeRegistry();
  for (const node of nodes) {
    registry.register(node);
  }
  return registry;
}

/** Build a registry pre-populated with the built-in nodes. */
export function createDefaultNodeRegistry(): NodeRegistry {
  return createNodeRegistry(defaultNodes());
}

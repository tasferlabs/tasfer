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

// TextNode must be imported (and thus module-evaluated) before ListNode, which
// `extends TextNode`: in the editor's circular import graph the base class has
// to be defined first, or `class ListNode extends TextNode` sees `undefined`.
import { ImageNode } from "./ImageNode";
import { LineNode } from "./LineNode";
import { ListNode } from "./ListNode";
import { MathNode } from "./MathNode";
import { Node, NodeRegistry } from "./Node";
import { TextNode } from "./TextNode";

export { AtomicNode } from "./AtomicNode";
export { getDragHandleAtPoint, ImageNode } from "./ImageNode";
export { LineNode } from "./LineNode";
export { LIST_BLOCK_TYPES, ListNode } from "./ListNode";
export { MathNode } from "./MathNode";
export {
  Node,
  type NodeActivateCtx,
  type NodeActivation,
  type NodeHitRegion,
  type NodeLayout,
  type NodeLayoutCtx,
  type NodePaintCtx,
  type NodePointerType,
  type NodeRegionCtx,
  NodeRegistry,
  type Point,
} from "./Node";
export {
  getContentWithComposition,
  TEXT_BLOCK_TYPES,
  TextNode,
  type TextNodeLayout,
} from "./TextNode";
export { UnknownNode } from "./UnknownNode";

/**
 * The built-in nodes. Each is constructed fresh here (the built-in nodes are
 * stateless, holding only layout/paint logic), so importing this module has no
 * side effects and no module-init ordering hazards.
 *
 * `TextNode` backs headings + paragraph; `ListNode` (a subclass) backs the
 * bullet/numbered/todo family. They register under disjoint type keys, so a
 * host can drop list support entirely by omitting `ListNode` from a custom
 * `nodes` list passed to `mountEditor`.
 */
function defaultNodes(): Node[] {
  return [
    new LineNode(),
    new ImageNode(),
    new MathNode(),
    new TextNode(),
    new ListNode(),
  ];
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

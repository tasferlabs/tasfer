/**
 * Node registry wiring.
 *
 * A `NodeRegistry` is per-editor-instance (created at mount, stored on
 * `EditorState.nodes`) — not a module global. Hosts compose the set of
 * nodes they want: pass a custom `nodes` list to `createEditor` to
 * opt in/out of block types, or use `defaultNodes()` for the built-in set.
 *
 * Two low-level primitives back everything: `TextNode` (text geometry: wrap,
 * caret, selection, hit-test) and `AtomicNode` (intrinsic-sized void/embed
 * boxes). Styled block types extend one of them — see ListNode extending
 * TextNode — and share the same layout/paint/hit-test API.
 */

// TextNode must be imported (and thus module-evaluated) before ListNode, which
// `extends TextNode`: in the editor's circular import graph the base class has
// to be defined first, or `class ListNode extends TextNode` sees `undefined`.
// ListNode `extends TextNode`; the module graph (it imports TextNode directly)
// guarantees TextNode evaluates first regardless of the order here, so these
// stay alphabetized.
import { ImageNode } from "../../nodes/ImageNode";
import { LineNode } from "../../nodes/LineNode";
import { ListNode } from "../../nodes/ListNode";
import { QuoteNode } from "../../nodes/QuoteNode";
import { TextNode } from "../../nodes/TextNode";
import { Node, NodeRegistry } from "./Node";

export type { CodeBlock } from "../../nodes/code-block";
export {
  canRepositionImage,
  canRepositionImageAt,
  ENTER_IMAGE_REPOSITION,
  EXIT_IMAGE_REPOSITION,
  ImageNode,
  isRepositioning,
} from "../../nodes/ImageNode";
export { LineNode } from "../../nodes/LineNode";
export {
  INDENT_LIST_ITEM,
  ListNode,
  OUTDENT_LIST_ITEM,
  TOGGLE_TODO_CHECKED,
} from "../../nodes/ListNode";
export { type QuoteBlock, QuoteNode } from "../../nodes/QuoteNode";
export {
  getContentWithComposition,
  paintTextRun,
  type PaintTextRunArgs,
  TextNode,
  type TextNodeLayout,
} from "../../nodes/TextNode";
export { AtomicNode } from "./AtomicNode";
export type { CaretModel, CaretMotion, TextSpan } from "./caret-model";
export {
  hitRegion,
  Node,
  type NodeActivateCtx,
  type NodeActivation,
  type NodeCaretRect,
  type NodeContentCaretCtx,
  type NodeContentHitCtx,
  type NodeContentHitOptions,
  type NodeContentSelectionGeometry,
  type NodeHitRegion,
  type NodeLayout,
  type NodeLayoutCtx,
  type NodePaintCtx,
  type NodePointerType,
  type NodeRect,
  type NodeRegionCtx,
  NodeRegistry,
  type NodeScrollCtx,
  type Point,
} from "./Node";

/**
 * Returns the built-in nodes, made new on each call: paragraph and headings
 * (`TextNode`), bullet, numbered and todo lists (`ListNode`), quote, image and
 * the divider line.
 *
 * Opt-in nodes such as math, code blocks and tables are not in this list. Add
 * them through their extensions.
 *
 * @group Nodes
 */
// Built-in nodes are stateless (layout/paint logic only), so building them
// inside this function keeps the module import free of side effects and
// module-init ordering hazards.
export function defaultNodes(): Node[] {
  return [
    new LineNode(),
    new ImageNode(),
    new QuoteNode(),
    new TextNode(),
    new ListNode(),
  ];
}

/**
 * Builds a node registry from the nodes you list. Only those block types get a
 * node. If two nodes claim the same block type, the later one wins.
 *
 * @group Nodes
 */
export function createNodeRegistry(nodes: readonly Node[]): NodeRegistry {
  const registry = new NodeRegistry();
  for (const node of nodes) {
    registry.register(node);
  }
  return registry;
}

/**
 * Build a registry pre-populated with the built-in nodes.
 *
 * @internal The editor builds this itself. Pass `createNodeRegistry(nodes)` a
 * custom list instead.
 */
export function createDefaultNodeRegistry(): NodeRegistry {
  return createNodeRegistry(defaultNodes());
}

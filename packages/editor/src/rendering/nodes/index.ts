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
  CANCEL_IMAGE_HANDLE_DRAG,
  cancelImageHandleDrag,
  canRepositionImage,
  canRepositionImageAt,
  CREATE_PARAGRAPH_BELOW_IMAGE,
  END_IMAGE_HANDLE_DRAG,
  endImageHandleDrag,
  ENTER_IMAGE_REPOSITION,
  EXIT_IMAGE_REPOSITION,
  getDragHandleAtPoint,
  ImageNode,
  imageObjectPosition,
  isRepositioning,
  SET_IMAGE_HOVER,
  START_IMAGE_HANDLE_DRAG,
  startImageHandleDrag,
  UPDATE_IMAGE_HANDLE_DRAG,
  UPDATE_IMAGE_REPOSITION,
  updateImageHandleDrag,
} from "../../nodes/ImageNode";
export { LineNode } from "../../nodes/LineNode";
export {
  INDENT_LIST_ITEM,
  LIST_BLOCK_TYPES,
  ListNode,
  OUTDENT_LIST_ITEM,
  TOGGLE_TODO_CHECKED,
} from "../../nodes/ListNode";
export { type QuoteBlock, QuoteNode } from "../../nodes/QuoteNode";
export {
  getContentWithComposition,
  paintTextRun,
  type PaintTextRunArgs,
  TEXT_BLOCK_TYPES,
  TextNode,
  type TextNodeLayout,
} from "../../nodes/TextNode";
export { AtomicNode } from "./AtomicNode";
export type { CaretModel, CaretMotion, TextSpan } from "./caret-model";
export { contentPointCaretRect } from "./content-caret";
export {
  hitRegion,
  Node,
  type NodeActivateCtx,
  type NodeActivation,
  type NodeAtomicHit,
  type NodeCaretRect,
  type NodeContentCaretCtx,
  type NodeContentHitCtx,
  type NodeContentHitOptions,
  type NodeHitRegion,
  type NodeLayout,
  type NodeLayoutCtx,
  type NodePaintCtx,
  type NodePointerType,
  type NodeRegionCtx,
  NodeRegistry,
  type Point,
} from "./Node";
export { UnknownNode } from "./UnknownNode";

/**
 * The built-in nodes. Each is constructed fresh here (the built-in nodes are
 * stateless, holding only layout/paint logic), so importing this module has no
 * side effects and no module-init ordering hazards.
 *
 * `TextNode` backs headings + paragraph; `ListNode` (a subclass) backs the
 * bullet/numbered/todo family. Optional feature nodes (notably math) are not in
 * this list: hosts install them through feature extensions.
 */
export function defaultNodes(): Node[] {
  return [
    new LineNode(),
    new ImageNode(),
    new QuoteNode(),
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

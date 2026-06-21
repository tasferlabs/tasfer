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
// CodeNode and ListNode both `extends TextNode`; the module graph (each imports
// TextNode directly) guarantees TextNode evaluates first regardless of the order
// here, so these stay alphabetized.
import { CodeNode } from "../../nodes/CodeNode";
import {
  CANCEL_IMAGE_HANDLE_DRAG,
  CREATE_PARAGRAPH_BELOW_IMAGE,
  END_IMAGE_HANDLE_DRAG,
  ImageNode,
  SET_IMAGE_HOVER,
  START_IMAGE_HANDLE_DRAG,
  UPDATE_IMAGE_HANDLE_DRAG,
} from "../../nodes/ImageNode";
import { LineNode } from "../../nodes/LineNode";
import {
  INDENT_LIST_ITEM,
  ListNode,
  OUTDENT_LIST_ITEM,
  TOGGLE_TODO_CHECKED,
} from "../../nodes/ListNode";
import {
  MathNode,
  SET_INLINE_MATH_HOVER,
  SET_MATH_BLOCK_HOVER,
} from "../../nodes/MathNode";
import { TextNode } from "../../nodes/TextNode";
import { Node, NodeRegistry } from "./Node";

export { type CodeBlock, CodeNode, INSERT_TAB } from "../../nodes/CodeNode";
export {
  CANCEL_IMAGE_HANDLE_DRAG,
  cancelImageHandleDrag,
  CREATE_PARAGRAPH_BELOW_IMAGE,
  END_IMAGE_HANDLE_DRAG,
  endImageHandleDrag,
  getDragHandleAtPoint,
  ImageNode,
  SET_IMAGE_HOVER,
  START_IMAGE_HANDLE_DRAG,
  startImageHandleDrag,
  UPDATE_IMAGE_HANDLE_DRAG,
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
export {
  MathNode,
  SET_INLINE_MATH_HOVER,
  SET_MATH_BLOCK_HOVER,
} from "../../nodes/MathNode";
export {
  getContentWithComposition,
  TEXT_BLOCK_TYPES,
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
  type NodeAtomicHit,
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
 * The built-in node commands, grouped — exposed at the package root as
 * `NodeActions`. Each is co-located with the node it acts on (list
 * indent/outdent + todo checkbox on `ListNode`, image hover + resize-handle drag
 * + paragraph-below on `ImageNode`, math hover on `MathNode`) and aggregated
 * here, the node registry's wiring point. Mostly intimate node-internal geometry;
 * the list/checkbox commands are the plausibly host-bindable members.
 */
export const NodeActions = {
  INDENT_LIST_ITEM,
  OUTDENT_LIST_ITEM,
  TOGGLE_TODO_CHECKED,
  SET_IMAGE_HOVER,
  START_IMAGE_HANDLE_DRAG,
  UPDATE_IMAGE_HANDLE_DRAG,
  END_IMAGE_HANDLE_DRAG,
  CANCEL_IMAGE_HANDLE_DRAG,
  CREATE_PARAGRAPH_BELOW_IMAGE,
  SET_MATH_BLOCK_HOVER,
  SET_INLINE_MATH_HOVER,
} as const;

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
export function defaultNodes(): Node[] {
  return [
    new LineNode(),
    new ImageNode(),
    new MathNode(),
    new CodeNode(),
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

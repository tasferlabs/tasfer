/**
 * `@tasfer/editor/rendering/nodes`: kept so 0.2 imports keep working.
 *
 * @deprecated Most of it is exported from `@tasfer/editor`: import it from
 * there. The names marked "not part of the public API" have no new home. This
 * entry point will be removed in a later release.
 */

export {
  /** @deprecated Import it from `@tasfer/editor` instead. */
  AtomicNode,
  /** @deprecated Import it from `@tasfer/editor` instead. */
  canRepositionImage,
  /** @deprecated Import it from `@tasfer/editor` instead. */
  canRepositionImageAt,
  /** @deprecated Import it from `@tasfer/editor` instead. */
  type CaretModel,
  /** @deprecated Import it from `@tasfer/editor` instead. */
  type CaretMotion,
  /** @deprecated Import it from `@tasfer/editor` instead. */
  type CodeBlock,
  /** @deprecated Import it from `@tasfer/editor` instead. */
  createNodeRegistry,
  /** @deprecated Import it from `@tasfer/editor` instead. */
  defaultNodes,
  /** @deprecated Import it from `@tasfer/editor` instead. */
  ENTER_IMAGE_REPOSITION,
  /** @deprecated Import it from `@tasfer/editor` instead. */
  EXIT_IMAGE_REPOSITION,
  /** @deprecated Import it from `@tasfer/editor` instead. */
  getContentWithComposition,
  /** @deprecated Import it from `@tasfer/editor` instead. */
  hitRegion,
  /** @deprecated Import it from `@tasfer/editor` instead. */
  ImageNode,
  /** @deprecated Import it from `@tasfer/editor` instead. */
  INDENT_LIST_ITEM,
  /** @deprecated Import it from `@tasfer/editor` instead. */
  isRepositioning,
  /** @deprecated Import it from `@tasfer/editor` instead. */
  LineNode,
  /** @deprecated Import it from `@tasfer/editor` instead. */
  ListNode,
  /** @deprecated Import it from `@tasfer/editor` instead. */
  Node,
  /** @deprecated Import it from `@tasfer/editor` instead. */
  type NodeActivateCtx,
  /** @deprecated Import it from `@tasfer/editor` instead. */
  type NodeActivation,
  /** @deprecated Import it from `@tasfer/editor` instead. */
  type NodeCaretRect,
  /** @deprecated Import it from `@tasfer/editor` instead. */
  type NodeContentCaretCtx,
  /** @deprecated Import it from `@tasfer/editor` instead. */
  type NodeContentHitCtx,
  /** @deprecated Import it from `@tasfer/editor` instead. */
  type NodeContentHitOptions,
  /** @deprecated Import it from `@tasfer/editor` instead. */
  type NodeContentSelectionGeometry,
  /** @deprecated Import it from `@tasfer/editor` instead. */
  type NodeHitRegion,
  /** @deprecated Import it from `@tasfer/editor` instead. */
  type NodeLayout,
  /** @deprecated Import it from `@tasfer/editor` instead. */
  type NodeLayoutCtx,
  /** @deprecated Import it from `@tasfer/editor` instead. */
  type NodePaintCtx,
  /** @deprecated Import it from `@tasfer/editor` instead. */
  type NodePointerType,
  /** @deprecated Import it from `@tasfer/editor` instead. */
  type NodeRect,
  /** @deprecated Import it from `@tasfer/editor` instead. */
  type NodeRegionCtx,
  /** @deprecated Import it from `@tasfer/editor` instead. */
  NodeRegistry,
  /** @deprecated Import it from `@tasfer/editor` instead. */
  type NodeScrollCtx,
  /** @deprecated Import it from `@tasfer/editor` instead. */
  OUTDENT_LIST_ITEM,
  /** @deprecated Import it from `@tasfer/editor` instead. */
  paintTextRun,
  /** @deprecated Import it from `@tasfer/editor` instead. */
  type PaintTextRunArgs,
  /** @deprecated Import it from `@tasfer/editor` instead. */
  type Point,
  /** @deprecated Import it from `@tasfer/editor` instead. */
  type QuoteBlock,
  /** @deprecated Import it from `@tasfer/editor` instead. */
  QuoteNode,
  /** @deprecated Import it from `@tasfer/editor` instead. */
  TextNode,
  /** @deprecated Import it from `@tasfer/editor` instead. */
  type TextNodeLayout,
  /** @deprecated Import it from `@tasfer/editor` instead. */
  type TextSpan,
  /** @deprecated Import it from `@tasfer/editor` instead. */
  TOGGLE_TODO_CHECKED,
} from "../index";
export {
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  CANCEL_IMAGE_HANDLE_DRAG,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  cancelImageHandleDrag,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  CREATE_PARAGRAPH_BELOW_IMAGE,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  END_IMAGE_HANDLE_DRAG,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  endImageHandleDrag,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  getDragHandleAtPoint,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  imageObjectPosition,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  SET_IMAGE_HOVER,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  START_IMAGE_HANDLE_DRAG,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  startImageHandleDrag,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  UPDATE_IMAGE_HANDLE_DRAG,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  UPDATE_IMAGE_REPOSITION,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  updateImageHandleDrag,
} from "../nodes/ImageNode";
export {
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  LIST_BLOCK_TYPES,
} from "../nodes/ListNode";
export {
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  TEXT_BLOCK_TYPES,
} from "../nodes/TextNode";
export {
  /** @deprecated Internal; this entry point will be removed. */
  createDefaultNodeRegistry,
} from "../rendering/nodes";
export {
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  contentPointCaretRect,
} from "../rendering/nodes/content-caret";
export type {
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  NodeAtomicHit,
} from "../rendering/nodes/Node";
export {
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  UnknownNode,
} from "../rendering/nodes/UnknownNode";

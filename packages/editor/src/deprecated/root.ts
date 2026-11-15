/**
 * Exports that `@tasfer/editor` no longer offers, kept so 0.2 imports keep
 * working. None of them is part of the public API any more.
 *
 * @deprecated Each will be removed in a later release.
 */

import type { MutationHandler } from "../action-bus";
import type {
  AnySchemaDefinition,
  MarkInfoFor,
  MarkNameOf,
  SchemaDefinition,
} from "../schema-types";

export {
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  isMutationAction,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  isStateAction,
} from "../action-bus";
export {
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  moveBlock,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  moveBlocks,
} from "../actions/actions";
export {
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  registerBreakReplacesSelection,
} from "../actions/edit-actions";
export {
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  CLEAR_SELECTION_IN_PADDING,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  CLEAR_VISUAL_BLOCK_SELECTION,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  OPEN_BLOCK_OVERLAY,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  PLACE_CURSOR_IN_PADDING,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  SELECT_VISUAL_BLOCK,
} from "../actions/mouse-actions";
export {
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  CLOSE_NODE_OVERLAY,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  OPEN_CONTEXT_MENU_AT,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  OPEN_NODE_OVERLAY,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  TAP_CLEAR_VISUAL_BLOCK_SELECTION,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  TAP_OUTSIDE_CONTENT,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  TAP_PLACE_CURSOR,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  TAP_SELECT_VISUAL_BLOCK,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  TAP_SIDE_PADDING,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  TAP_TOP_PADDING,
} from "../actions/touch-actions";
export {
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  PERSISTED_DOC_VERSION,
} from "../doc";
export {
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  mountEditor,
} from "../entries/mount";
export type {
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  ResolvedFeatureThemeDefaults,
} from "../feature-facets";
export {
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  CANCEL_IMAGE_HANDLE_DRAG,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  CREATE_PARAGRAPH_BELOW_IMAGE,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  END_IMAGE_HANDLE_DRAG,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  imageObjectPosition,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  SET_IMAGE_HOVER,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  START_IMAGE_HANDLE_DRAG,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  UPDATE_IMAGE_HANDLE_DRAG,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  UPDATE_IMAGE_REPOSITION,
} from "../nodes/ImageNode";
export type {
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  DecorationLayers,
} from "../rendering/decorations";
export {
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  createDefaultNodeRegistry,
} from "../rendering/nodes";
export {
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  BoxNode,
} from "../rendering/nodes/BoxNode";
export type {
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  NodeAtomicHit,
} from "../rendering/nodes/Node";
export {
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  UnknownNode,
} from "../rendering/nodes/UnknownNode";
export {
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  captureContentSelection,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  cloneContentSelection,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  contentGapPointsEqual,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  contentSelectionsEqual,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  contentTextPointsEqual,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  isSameContentGapSlot,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  isSameContentTextField,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  normalizeContentGapPoint,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  normalizeContentPoint,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  normalizeContentTextPoint,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  reconcileContentSelectionState,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  restoreContentSelection,
} from "../structured-selection";
export {
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  type CompiledContent,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  ContentMatch,
} from "../sync/content-expression";
export type {
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  StructuredKindAdapters,
} from "../sync/schema";
export {
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  applyStructuredMutation,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  hasStructuredBlockAuthority,
} from "../sync/structured-content";
export {
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  FIELD_PARAGRAPH_REVERT,
} from "../text-field-paragraph";
export {
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  isSafeLinkUrl,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  SAFE_LINK_PROTOCOLS,
} from "../url-safety";
export {
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  titleBlockIndex,
} from "../view-window";
export {
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  invariant,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  InvariantError,
} from "@shared/invariant";

/** @deprecated Not part of the public API any more. It will be removed in a later release. */
export type MarkName<S extends SchemaDefinition = AnySchemaDefinition> =
  MarkNameOf<S>;

/** @deprecated Not part of the public API any more. It will be removed in a later release. */
export type Mutator<P = void> = MutationHandler<P>;

/** @deprecated Not part of the public API any more. It will be removed in a later release. */
export type SchemaMarkInfo<S extends SchemaDefinition> = {
  [T in MarkNameOf<S>]: MarkInfoFor<S, T>;
}[MarkNameOf<S>];

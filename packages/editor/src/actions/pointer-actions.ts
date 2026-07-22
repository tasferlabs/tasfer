/**
 * Generic **pointer / cursor interaction actions** — the single dispatch surface
 * for clicks, desktop hover, and boundary-crossing caret moves. They replace the
 * two parallel mechanisms the event layer used to run: the per-node virtual-hook
 * loops (`node.onTextClick` / `node.onPointerMove`) and the inline link/inline-
 * math special-casing. Now nodes AND marks contribute interaction behavior the
 * same way every other extension does — by registering action-bus handlers in
 * `registerActions(bus)` (see `Node.registerActions` / `Mark.registerActions`).
 *
 * The event layer stays presentation-agnostic: it hit-tests the pointer against
 * the viewport (resolving the caret position, the atomic block, raw pointer
 * coords, modifiers) and dispatches one of these. Handlers are pure over
 * `EditorState` and never hit-test — every event-derived value arrives in the
 * payload. Claim semantics follow {@link StateHandler}: return
 * `{ state, ops, handled: true }` to claim, `{ state, ops: [] }` to observe,
 * `void` to pass through unchanged.
 *
 * Priority convention (higher runs first):
 *   100 — link Ctrl/Cmd+click open (must pre-empt caret placement)
 *    50 — node click claims (inline-math chip, trailing-image paragraph)
 *     0 — hover / cursor-cross observers (host default)
 *    −∞ — TEXT_CLICK's default caret placement (runs last, only if unclaimed)
 */

import { stateAction } from "../action-bus";
import type { NodeAtomicHit } from "../rendering/nodes/Node";
import type { Block } from "../serlization/loadPage";
import type { ActiveMenu, Position, ViewportState } from "../state-types";

/** Document-space coordinates of a caret position (the shape
 *  `getCursorDocumentCoords` returns). */
export interface DocCoords {
  x: number;
  y: number;
  height: number;
}

/**
 * Resolve a caret position to document coordinates. The event layer (which owns
 * geometry / the `selection` module) provides this on the pointer/cursor action
 * payloads so handlers can position overlays/tooltips without importing
 * `selection` — keeping mark handlers free of the `selection` → `state-utils`
 * import chain they'd otherwise close a load-order cycle with.
 */
export type CoordsResolver = (position: Position) => DocCoords | null;

/** Keyboard modifiers carried with a pointer interaction. */
export interface PointerModifiers {
  /** Ctrl (or Cmd on macOS) — the link-open / multi-select modifier. */
  readonly ctrlOrMeta: boolean;
  /** Shift — extends the active selection on click. */
  readonly shift: boolean;
}

/**
 * A single click that resolved to a caret position. Dispatched on the text-caret
 * branch of `handleMouseDown` (and from touch tap), AFTER the region hit-test and
 * atomic-`activate` steps have had their chance. Higher-priority handlers (link
 * open, inline-math chip, trailing-image paragraph) claim it via `handled: true`.
 *
 * The **default is a no-op**: caret placement is left to the dispatching event
 * handler when nothing claims the click (`dispatchState(...).claimed === false`),
 * because desktop and touch place the caret differently (`PLACE_CURSOR_AT_POINT`
 * vs `TAP_PLACE_CURSOR`). Keeping caret placement out of this action also keeps
 * `pointer-actions` a leaf module — it must stay free of the
 * `state-utils`/`selection` import chain, since marks (which register handlers on
 * these actions) are themselves constructed by `state-utils`.
 */
export const TEXT_CLICK = stateAction<{
  canvasX: number;
  canvasY: number;
  position: Position;
  /** The active menu BEFORE this click (handlers that reopen an overlay read it). */
  previousMenu: ActiveMenu;
  viewport: ViewportState;
  modifiers: PointerModifiers;
}>("text-click", (state) => ({ state, ops: [] }));

/**
 * A desktop pointer move. Dispatched from `handleMouseMove` once per move with
 * the atomic block + caret position already resolved. Handlers update their own
 * hover UI (image resize-handle hover, math block / inline-math chip hover, link
 * tooltip) and **observe only** — they return `{ state, ops: [] }`, never claim.
 * Default is a no-op. Hover hit-tests (including the link-tooltip keep-open
 * hysteresis) use `canvasX`/`canvasY`, which share the canvas/container space of
 * the stored `ui.linkHover` anchor.
 */
export const POINTER_MOVE = stateAction<{
  canvasX: number;
  canvasY: number;
  textPosition: Position | null;
  /**
   * The `originalIndex` of the block actually under the pointer, or `null` in the
   * empty space above the first / below the last block. Unlike `textPosition`
   * (which clamps to the nearest block), this is bounds-exact — handlers gate
   * whole-block hover on it so the effect switches off outside the block.
   */
  blockUnderPoint: number | null;
  atomicBlock: NodeAtomicHit | null;
  viewport: ViewportState;
  /** Resolve a caret position to document coords (link tooltip anchor, …). */
  resolveCoords: CoordsResolver;
  modifiers: { readonly ctrlOrMeta: boolean };
}>("pointer-move", (state) => ({ state, ops: [] }));

/**
 * A caret move that may have crossed an inline span/boundary — dispatched after
 * an Arrow Left/Right move, gated on staying within the same block (matching the
 * old `maybeOpenInlineMathOnArrowCross`). MathMark observes it to open the inline-
 * math editor when the caret steps across a math chip. Default is a no-op; do not
 * broaden the dispatch to other caret moves or unrelated moves would trigger it.
 */
export const CURSOR_MOVED = stateAction<{
  block: Block;
  blockIndex: number;
  oldIndex: number;
  newIndex: number;
  direction: "left" | "right";
  viewport: ViewportState;
  /** Resolve a caret position to document coords (inline-math overlay anchor). */
  resolveCoords: CoordsResolver;
}>("cursor-moved", (state) => ({ state, ops: [] }));

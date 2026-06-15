/**
 * Editor **state commands** — the imperative actions that key/mouse handlers
 * used to inline, lifted into named, dispatchable {@link StateCommand}s.
 *
 * A state command is the low-level command shape: its default behavior is a
 * pure `(state) => { state, ops }` transform (see `command-bus.ts`), which is
 * exactly the currency the event pipeline already trades in. That lets it
 * express moves a {@link MutationCommand}'s `ChangeApi` can't — e.g. a
 * cursor/selection change that emits no CRDT ops. Handlers dispatch these via
 * `state.commandBus.dispatchState(...)`, so hosts/plugins can observe or
 * override them, and the engine's logic lives in one named place instead of
 * being scattered across the switch statements in `keysEvents.ts`.
 *
 * This file is intentionally being grown one command at a time — start small,
 * migrate handlers incrementally. The first migrated action is the plain
 * caret-left move.
 */

import { stateCommand } from "../command-bus";
import { clearSelection, moveCursorLeft } from "../selection";

/**
 * Move the caret one position to the left, collapsing any active selection
 * first. Emits no ops — a pure cursor move. This is the atomic left-arrow
 * primitive; the surrounding ArrowLeft special cases (word jumps, selection
 * collapse, visual-block selection) remain in the handler for now and will be
 * migrated into their own commands over time.
 */
export const MOVE_CURSOR_LEFT = stateCommand("move-cursor-left", (state) => ({
  state: moveCursorLeft(clearSelection(state)),
  ops: [],
}));

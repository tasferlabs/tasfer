/**
 * Action bus — a small, Lexical-style dispatch primitive that lets hosts and
 * plugins hook the editor's imperative actions without the engine knowing who
 * is listening. It sits alongside the schema's `defineNode` / `defineMark` as a
 * third extension primitive: `action` declares a typed action,
 * `editor.dispatch` fires it, `editor.registerAction` listens.
 *
 * Two usage patterns fall out of one mechanism (priority + a "handled" return):
 *   - **override** — return `true` to claim the action and stop propagation,
 *     skipping the editor's built-in default (e.g. a native shell taking over
 *     {@link OPEN_LINK} to route the URL itself).
 *   - **observe**  — return `false`/`void` to react and let dispatch continue
 *     to lower-priority handlers, including the default (e.g. haptics reacting
 *     to {@link REGION_DRAG_START}).
 *
 * Naming convention: actions name what the editor *did* (`open-link`,
 * `region-drag-start`), never what a consumer does with it (no "haptic"
 * action). Consumers map those actions to their own effects.
 *
 * The handler registry is per editor instance (`createActionBus`, carried on
 * `EditorState.actionBus` like `nodes`/`marks`) — never a module global — so
 * two editors on a page keep independent listeners.
 */

import type { ChangeApi } from "./entries/editor";
import type { DocPoint } from "./positions";
import type { EditorState, Operation } from "./state-types";

/**
 * An action, with the type of its payload. It holds no state, so declare it
 * once at module level and share it between editors. Make one with
 * {@link action} or {@link stateAction}.
 *
 * @group Actions
 */
// The `_p` field is phantom: type-only, never read at runtime.
export interface Action<P = void> {
  /**
   * A readable name, only for debugging. Two actions with the same name are
   * still different actions.
   */
  readonly name: string;
  /** @internal Phantom marker threading the payload type through the API. */
  readonly _p?: P;
}

/**
 * A handler for a mutation action. It gets the editor's {@link ChangeApi} and
 * the payload, so its edits land in the same undo step as the default. Return
 * `true` to claim the action and skip the default edit. Return `false` or
 * nothing to just watch. Edits it made still apply either way.
 *
 * @group Actions
 */
export type MutationHandler<P = void> = (
  c: ChangeApi,
  payload: P,
) => boolean | void;

/**
 * An action whose default behavior edits the document. Unlike a plain
 * {@link Action}, dispatching it runs every handler and the default inside one
 * `change()`. That makes one undo step, one update sent to other people, and
 * one `change` event. A handler that returns `true` skips the default. It is
 * still an {@link Action}, so a schema shortcut can point at it.
 *
 * @group Actions
 */
export interface MutationAction<P = void> extends Action<P> {
  readonly mutate: MutationHandler<P>;
}

/**
 * Declare an action. `name` is only for debugging. Two actions with the same
 * name are still different actions.
 *
 * Pass a `mutate` function to make a {@link MutationAction}, an action that
 * edits the document. `editor.dispatch` runs it and every handler as one undo
 * step. `mutate` must only use the {@link ChangeApi} it gets. Then the action
 * is safe to declare once and share between editors.
 *
 * ```ts
 * const INSERT_DATE = action<{ date: string }>("insert-date", (c, { date }) => {
 *   c.insertText(date);
 * });
 *
 * editor.dispatch(INSERT_DATE, { date: "2026-11-14" });
 * ```
 *
 * @group Actions
 */
export function action<P = void>(name: string): Action<P>;
export function action<P = void>(
  name: string,
  mutate: MutationHandler<P>,
): MutationAction<P>;
export function action<P = void>(
  name: string,
  mutate?: MutationHandler<P>,
): Action<P> | MutationAction<P> {
  return mutate ? { name, mutate } : { name };
}

/**
 * Returns `true` when `c` is a {@link MutationAction}, an action made with a
 * `mutate` function.
 */
// editor.dispatch and schema shortcuts use this to pick the mutation path.
export function isMutationAction<P>(c: Action<P>): c is MutationAction<P> {
  return typeof (c as Partial<MutationAction<P>>).mutate === "function";
}

/**
 * The `{ state, ops }` pair every editor action returns, and what a
 * {@link StateAction} works with. `state` is the new editor state. `ops` is the
 * list of document edits it made. It is empty when only the caret or selection
 * moved.
 *
 * @group Actions
 */
export interface StateResult {
  state: EditorState;
  ops: Operation[];
}

/**
 * A state action's default behavior. It takes the whole {@link EditorState} and
 * the payload, and returns a {@link StateResult}. It must not change the state
 * it gets. It can do things a {@link MutationAction}'s {@link ChangeApi}
 * cannot, like moving the caret or selection without editing the document.
 *
 * @group Actions
 */
export type StateMutator<P = void> = (
  state: EditorState,
  payload: P,
) => StateResult;

/**
 * A handler for a state action. It gets the payload and the current state, with
 * changes from higher-priority handlers already in it. Return a
 * {@link StateResult} to make changes. Add `handled: true` to claim the action:
 * lower-priority handlers and the default then do not run. Return nothing to
 * just watch.
 *
 * @group Actions
 */
export type StateHandler<P = void> = (
  state: EditorState,
  payload: P,
) => (StateResult & { handled?: boolean }) | void;

/**
 * An action whose default behavior is a {@link StateMutator}. Unlike a
 * {@link MutationAction}, it can move the caret or selection without editing
 * the document. It runs through {@link ActionBus.dispatchState}, or
 * `editor.dispatch` on a live editor. It is still an {@link Action} and shares
 * the same handler list.
 *
 * @group Actions
 */
export interface StateAction<P = void> extends Action<P> {
  readonly transform: StateMutator<P>;
  /** See {@link StateActionOptions.forwardable}. */
  readonly forwardable?: boolean;
}

/**
 * Options for {@link stateAction}.
 *
 * @group Actions
 */
export interface StateActionOptions {
  /**
   * The action edits at the caret, the way a key press does, so a node that
   * edits its text fields with the paragraph's own code may run it there
   * instead. Set it on an action a feature declares for its own content (an
   * inline formula's command insert): a node that holds that content in a
   * field (a table cell's formula) and registered a
   * {@link ActionBus.registerForwarder forwarder} then answers it without
   * having to know the action. Off by default.
   */
  readonly forwardable?: boolean;
}

/**
 * Declare a state action (see {@link StateAction}). `name` is only for
 * debugging. `transform` gets the editor state and the payload, and returns the
 * new state plus the edits it made. It must only use the `state` it gets, so
 * the action is safe to share between editors. See {@link StateActionOptions}
 * for `options`.
 *
 * ```ts
 * // A hook that does nothing by default. Nodes add handlers for it.
 * const BLOCK_TOUCHED = stateAction<{ blockIndex: number }>(
 *   "block-touched",
 *   (state) => ({ state, ops: [] }),
 * );
 *
 * editor.dispatch(BLOCK_TOUCHED, { blockIndex: 0 });
 * ```
 *
 * @group Actions
 */
export function stateAction<P = void>(
  name: string,
  transform: StateMutator<P>,
  options: StateActionOptions = {},
): StateAction<P> {
  return options.forwardable
    ? { name, transform, forwardable: true }
    : { name, transform };
}

/**
 * A handler for every {@link StateActionOptions.forwardable forwardable}
 * action no action-specific handler claimed — see
 * {@link ActionBus.registerForwarder}. It gets the action itself, so it can
 * dispatch the same action somewhere else (a stand-in paragraph) with the
 * same payload.
 *
 * @group Actions
 */
export type StateForwarder = <P>(
  state: EditorState,
  action: StateAction<P>,
  payload: P,
) => (StateResult & { handled?: boolean }) | void;

/**
 * Returns `true` when `c` is a {@link StateAction}, an action made with
 * {@link stateAction}.
 */
// editor.dispatch uses this to pick the state-transform path.
export function isStateAction<P>(c: Action<P>): c is StateAction<P> {
  return typeof (c as Partial<StateAction<P>>).transform === "function";
}

/**
 * A handler for an action. Return `true` to claim the action. Then
 * lower-priority handlers and the editor's default do not run. Return `false`
 * or nothing to just watch, and the action moves on to lower-priority handlers.
 *
 * @group Actions
 */
export type ActionHandler<P = void> = (payload: P) => boolean | void;

/** Trailing args `dispatch` takes after the action: none for `void` payloads. */
export type DispatchArgs<P> = [P] extends [void] ? [] : [payload: P];

/**
 * Priority of the editor's built-in default handlers. Below any host handler
 * (which default to `0`), so a host always gets first refusal and can override
 * a default by returning `true`.
 */
export const DEFAULT_ACTION_PRIORITY = -Infinity;

/**
 * The message board one editor uses for its actions. Handlers register for an
 * action; dispatching the action runs them from highest priority to lowest
 * until one claims it. Each editor has its own bus, and a custom node or mark
 * receives it in `registerActions` to listen for, or override, an action.
 *
 * @group Actions
 */
export interface ActionBus {
  /**
   * Register `handler` for `action`. Higher `priority` runs first (default
   * `0`); ties run in registration order. Returns an unsubscribe function.
   */
  register<P>(
    action: Action<P>,
    handler: ActionHandler<P>,
    priority?: number,
  ): () => void;
  /**
   * Register a {@link StateHandler} for a {@link StateAction}. It works like
   * {@link register}, with the same priority and claim rules. The difference is
   * the handler: it gets the current state and the payload, and can return a
   * {@link StateResult}. Returns an unsubscribe function.
   */
  registerState<P>(
    action: StateAction<P>,
    handler: StateHandler<P>,
    priority?: number,
  ): () => void;
  /**
   * Run `action`'s handlers high→low priority, stopping at the first that
   * returns `true`. Returns whether any handler claimed it.
   */
  dispatch<P>(action: Action<P>, ...args: DispatchArgs<P>): boolean;
  /**
   * Notify every handler high→low priority, ignoring handled return values.
   * Use for events that describe state already applied and therefore cannot be
   * overridden, such as programmatic viewport changes.
   */
  notify<P>(action: Action<P>, ...args: DispatchArgs<P>): void;
  /**
   * Run a {@link StateAction} on `state`. Its handlers run from highest
   * priority to lowest. Each one gets the state as the handlers before it left
   * it. If none claims it (`handled: true`) and the action is
   * {@link StateActionOptions | forwardable}, forwarders run next. Then the
   * default runs, unless something claimed the action.
   *
   * Returns the final `state`, every edit made along the way in `ops`, and
   * `claimed`. `claimed` is `true` when a handler or forwarder claimed the
   * action, so the default did not run.
   *
   * It does not apply anything to an editor. To run a state action on a live
   * editor, use `editor.dispatch`.
   */
  // The event pipeline calls this with the working state and commits the
  // result. The touch tap path reads `claimed` to run its own caret placement
  // only when no node or mark claimed the tap.
  dispatchState<P>(
    action: StateAction<P>,
    state: EditorState,
    ...args: DispatchArgs<P>
  ): StateResult & { claimed: boolean };
  /**
   * Register `forwarder` for every {@link StateActionOptions | forwardable}
   * state action. It runs after the action's own handlers all pass, and before
   * its default. Forwarders run from highest `priority` to lowest. Like a
   * handler, a forwarder can claim the action. Returns an unsubscribe function.
   *
   * A node that keeps text in its own fields (a table cell) uses one
   * forwarder to run a feature's actions there, such as a math command, without
   * knowing those actions. Return nothing when the caret is not in your node,
   * so the action goes on. {@link runFieldAsParagraph} then runs the same action
   * on the field. Inside that paragraph your forwarder finds no field of its own
   * and passes, so the feature's own handler answers.
   *
   * @example
   * ```ts
   * bus.registerForwarder((state, action, payload) => {
   *   const cell = activeCell(state);
   *   if (!cell) return undefined; // not ours: the action goes on
   *   const run = runFieldAsParagraph(state, cell.address, cell.range, (paragraph) =>
   *     paragraph.actionBus.dispatchState(action, paragraph, payload),
   *   );
   *   return run.kind === "applied"
   *     ? { state: run.state, ops: run.ops, handled: true }
   *     : { state, ops: [], handled: true };
   * }, 100);
   * ```
   */
  // Keep `{@link StateActionOptions.forwardable forwardable}` on one source
  // line so the generator does not pick up the `*` from the next line.
  registerForwarder(forwarder: StateForwarder, priority?: number): () => void;
  /**
   * The handlers registered for `action`, highest priority first. Use it when
   * you call the handlers yourself with other arguments. The editor does this
   * for mutation actions, which pass a {@link ChangeApi} to each handler.
   */
  handlersFor<P>(action: Action<P>): readonly ActionHandler<P>[];
}

interface Registered {
  handler: ActionHandler<unknown>;
  priority: number;
}

export function createActionBus(): ActionBus {
  const handlers = new Map<Action<unknown>, Registered[]>();
  const forwarders: { forwarder: StateForwarder; priority: number }[] = [];
  // Shared registration body for both `register` (payload handlers, the
  // `dispatch` path) and `registerState` (state handlers, the `dispatchState`
  // path). Both kinds live in one list keyed by action; the dispatch method that
  // walks them knows which shape to call.
  const add = (
    action: Action<unknown>,
    handler: ActionHandler<unknown>,
    priority: number,
  ): (() => void) => {
    const list = handlers.get(action) ?? [];
    const entry: Registered = { handler, priority };
    // Keep the list sorted high→low so dispatch is a straight walk. A new
    // entry goes before the first strictly-lower one — so equal priorities
    // preserve registration order (the new one runs after existing peers).
    const at = list.findIndex((e) => e.priority < priority);
    if (at === -1) list.push(entry);
    else list.splice(at, 0, entry);
    handlers.set(action, list);
    return () => {
      const arr = handlers.get(action);
      if (!arr) return;
      const i = arr.indexOf(entry);
      if (i > -1) arr.splice(i, 1);
    };
  };
  return {
    register(action, handler, priority = 0) {
      return add(
        action as Action<unknown>,
        handler as ActionHandler<unknown>,
        priority,
      );
    },
    registerState(action, handler, priority = 0) {
      return add(
        action as Action<unknown>,
        handler as unknown as ActionHandler<unknown>,
        priority,
      );
    },
    dispatch(action, ...args) {
      const list = handlers.get(action);
      if (!list || list.length === 0) return false;
      const payload = (args as unknown[])[0];
      // Walk a copy so a handler that (un)registers mid-dispatch can't shift
      // the array out from under the loop.
      for (const { handler } of list.slice()) {
        if (handler(payload) === true) return true;
      }
      return false;
    },
    notify(action, ...args) {
      const list = handlers.get(action);
      if (!list || list.length === 0) return;
      const payload = (args as unknown[])[0];
      for (const { handler } of list.slice()) handler(payload);
    },
    dispatchState(action, state, ...args) {
      const payload = (args as unknown[])[0];
      let working: StateResult = { state, ops: [] };
      let claimed = false;
      // Walk a copy so a handler that (un)registers mid-dispatch can't shift the
      // array out from under the loop (same guard as `dispatch`).
      const list = handlers.get(action as Action<unknown>) ?? [];
      for (const { handler } of list.slice()) {
        const r = (handler as unknown as StateHandler<unknown>)(
          working.state,
          payload,
        );
        if (r) {
          working = { state: r.state, ops: working.ops.concat(r.ops) };
          if (r.handled) {
            claimed = true;
            break;
          }
        }
      }
      if (!claimed && action.forwardable) {
        for (const { forwarder } of forwarders.slice()) {
          const r = forwarder(working.state, action, payload as never);
          if (r) {
            working = { state: r.state, ops: working.ops.concat(r.ops) };
            if (r.handled) {
              claimed = true;
              break;
            }
          }
        }
      }
      if (!claimed) {
        const r = action.transform(working.state, payload as never);
        working = { state: r.state, ops: working.ops.concat(r.ops) };
      }
      return { ...working, claimed };
    },
    registerForwarder(forwarder, priority = 0) {
      const entry = { forwarder, priority };
      // Sorted high→low, ties in registration order — as for handlers.
      const at = forwarders.findIndex((e) => e.priority < priority);
      if (at === -1) forwarders.push(entry);
      else forwarders.splice(at, 0, entry);
      return () => {
        const i = forwarders.indexOf(entry);
        if (i > -1) forwarders.splice(i, 1);
      };
    },
    handlersFor(action) {
      const list = handlers.get(action as Action<unknown>) ?? [];
      return list.map(
        (e) => e.handler,
      ) as readonly ActionHandler<unknown>[] as never;
    },
  };
}

/**
 * A teardown function — what `editor.registerAction`, `editor.subscribe`,
 * `doc.on`, and friends return. Calling it undoes the registration.
 *
 * @group Actions
 */
export type Disposer = () => void;

/**
 * Combine several teardown functions into one. `editor.registerAction`,
 * `editor.subscribe` and `doc.on` each return a {@link Disposer}. Pass them all
 * here and keep the one function it returns. Then cleanup is a single call, and
 * no handler is left running by mistake.
 *
 * ```ts
 * const dispose = mergeRegister(
 *   editor.registerAction(OPEN_LINK, openNatively),
 *   editor.registerAction(CURSOR_DRAG_END, buzz),
 *   editor.subscribe(rerender),
 * );
 * // later (effect cleanup): dispose();
 * ```
 *
 * The disposers run in the order you passed them. Calling the returned function
 * a second time does nothing.
 *
 * @group Actions
 */
// Mirrors Lexical's mergeRegister from @lexical/utils; the list is cleared
// after the first call so captured closures can be collected.
export function mergeRegister(...disposers: Disposer[]): Disposer {
  return () => {
    for (const dispose of disposers) dispose();
    // Drop references so a second call is a safe no-op and captured closures
    // can be GC'd.
    disposers.length = 0;
  };
}

// ─── Built-in actions ─────────────────────────────────────────────────────

/**
 * A link was activated (Cmd/Ctrl-click on a `link` mark). Payload: the URL —
 * untrusted document content, not a vetted address.
 *
 * The editor registers a default handler at {@link DEFAULT_ACTION_PRIORITY}
 * that opens the url in a new tab if its scheme passes `normalizeLinkUrl`, and
 * drops it otherwise. A host can register a higher-priority handler returning
 * `true` to route the link itself (native nav, a confirmation step); doing so
 * makes the host responsible for the same protocol check.
 *
 * @group Built-in actions
 */
export const OPEN_LINK = action<{ url: string }>("open-link");

/**
 * Where the finger is during a touch caret drag. It does not include the
 * caret's position. Get that from `editor.view.coordsAtPos("caret")`. Use
 * `touchX` to point a magnifier at the finger, and `touchRadiusY` to place the
 * magnifier above the fingertip.
 *
 * @group Built-in actions
 */
export interface CursorDragInfo {
  /** Finger contact X (canvas/viewport coords). */
  readonly touchX: number;
  /** Finger contact Y (canvas/viewport coords). */
  readonly touchY: number;
  /** Finger contact radius X (px) for finger-aware placement; 0 if unknown. */
  readonly touchRadiusX: number;
  /** Finger contact radius Y (px) for finger-aware placement; 0 if unknown. */
  readonly touchRadiusY: number;
}

/**
 * A touch cursor-drag gesture began. Observe-only (no editor default).
 *
 * @group Built-in actions
 */
export const CURSOR_DRAG_START = action<CursorDragInfo>("cursor-drag-start");

/**
 * The touch-dragged caret moved (per-tick finger geometry). Observe-only.
 *
 * @group Built-in actions
 */
export const CURSOR_DRAG_MOVE = action<CursorDragInfo>("cursor-drag-move");

/**
 * The touch-dragged caret crossed a character/line boundary. Observe-only.
 *
 * @group Built-in actions
 */
export const CURSOR_DRAG_BOUNDARY = action("cursor-drag-boundary");

/**
 * A touch cursor-drag gesture ended (finger lifted). Observe-only.
 *
 * @group Built-in actions
 */
export const CURSOR_DRAG_END = action("cursor-drag-end");

/**
 * A touch hold turned into a drag: a selection handle, an image resize, a
 * scrollbar, and so on. It only fires for drag areas that need a hold and set
 * an `activationIntensity`. `regionId` names the drag area. `intensity` is
 * `"light"`, `"medium"` or `"heavy"`. A host turns it into a haptic or a sound.
 * Observe-only.
 *
 * @group Built-in actions
 */
export const REGION_DRAG_START = action<{
  regionId: string;
  intensity: "light" | "medium" | "heavy";
}>("region-drag-start");

/**
 * A drag passed a snap point the user should feel. For example, an image resize
 * snapped to full width, or a slider passed a tick. A host can play a light
 * haptic. Caret drags use {@link CURSOR_DRAG_BOUNDARY} instead. Observe-only.
 *
 * @group Built-in actions
 */
export const DRAG_DETENT = action("drag-detent");

/**
 * A key press on this device just typed text into a block. `text` is what was
 * typed. `blockIndex` and `textIndex` say where it landed. Inside structured
 * content, such as a formula, `textIndex` is 0 and `contentPoint` gives the
 * exact spot. `inputSource` says whether the key came from a physical keyboard
 * or the editor's text input, like an on-screen keyboard. A space does not fire
 * it. Observe-only.
 *
 * Use it to open a menu when the user types a character, like `/` for a slash
 * menu. It fires once per key press, so the menu does not reopen later just
 * because an old `/` is still in the text.
 *
 * @group Built-in actions
 */
export const TEXT_INPUT = action<{
  text: string;
  blockIndex: number;
  textIndex: number;
  /** Whether the character came from a physical key or the software input surface. */
  inputSource?: "hardware-keyboard" | "input-surface";
  /** Stable nested landing point when a structured feature consumed the key. */
  contentPoint?: import("./structured-selection").ContentPoint;
}>("text-input");

/**
 * Runs right after typed text is inserted, with the caret at `textIndex` in
 * `blockIndex`. It runs inside the same edit, so anything a handler changes
 * joins the same undo step.
 *
 * A node or mark observes it in `registerActions` to finish what the user just
 * typed. For example, math turns `\frac` into `\frac{}{}` and puts the caret in
 * the first slot. By default it does nothing. Handlers return `{ state, ops }`
 * like any {@link StateAction}.
 *
 * @group Built-in actions
 */
// This is the effect half of the caret/edit seam, the counterpart to the pure
// query hooks on CaretModel; observers may also arm caret-anchored scratch
// here. It plays the role of a post-edit normalization pass (ProseMirror's
// appendTransaction, Lexical's node transforms): core only dispatches, the
// node/mark decides what to fill in.
export const TEXT_INPUTTED = stateAction<{
  blockIndex: number;
  textIndex: number;
}>("text-inputted", (state) => ({ state, ops: [] }));

/**
 * Post-delete normalization — the Backspace/Delete counterpart to
 * {@link TEXT_INPUTTED}. Dispatched by the delete actions *after* the removal is
 * applied and the caret settled at `textIndex` in `blockIndex`, *inside the same
 * edit transform*, so any ops an observer emits join the one CRDT change / undo
 * entry / broadcast. A node/mark observes this (in `registerActions`) to reconcile
 * inline runs a deletion just changed — e.g. inline math fuses two chips back into
 * one when the plain text that separated them is gone. Default is identity;
 * observers thread `{ state, ops }` like any {@link StateAction}. The core stays
 * type-agnostic: it only dispatches; the node/mark decides what, if anything, to fix.
 */
export const CONTENT_DELETED = stateAction<{
  blockIndex: number;
  textIndex: number;
}>("content-deleted", (state) => ({ state, ops: [] }));

/**
 * A block that owns structured content is being converted to another type —
 * dispatched by the core conversion paths (the caret conversion and the
 * generic `setBlock({ type })` morph) *instead of* refusing outright, so the
 * feature that owns the attachment can run the conversion losslessly. Core
 * cannot: a generic flat morph would orphan the persisted structured document
 * (or duplicate its stale compatibility projection as real content). A feature
 * handler claims (`handled: true`) with the complete transaction — e.g. math
 * promotes a paragraph whose only content is one attached inline chip into a
 * tree-backed display equation. Default is identity; an unclaimed dispatch
 * leaves the conversion refused, exactly as before this seam existed.
 */
export const CONVERT_STRUCTURED_BLOCK = stateAction<{
  blockIndex: number;
  type: string;
}>("convert-structured-block", (state) => ({ state, ops: [] }));

/**
 * Payload for {@link IMAGE_PASTE}: the pasted file and the stable id of the
 * image block created to hold it.
 *
 * @group Built-in actions
 */
export interface ImagePasteEvent {
  /** The pasted image file. */
  readonly file: File;
  /** Stable id of the image block created for this paste. */
  readonly blockId: string;
}

/**
 * An image was pasted, like a screenshot. The editor has already inserted an
 * image block for it. Observe it to upload `file` and set the block's url. The
 * block is named by `blockId`, so you still find the right block if other edits
 * move it while the upload runs.
 *
 * A custom image node can register at a higher priority and return `true` to
 * handle the upload itself. The editor has no default handler.
 *
 * @group Built-in actions
 */
export const IMAGE_PASTE = action<ImagePasteEvent>("image-paste");

/**
 * The page is about to scroll from user input: a wheel, a touch drag, or
 * momentum. It fires before the page moves. A node under the pointer, like a
 * drawing board, can return `true` to keep the page still and use the scroll
 * itself. Otherwise the editor scrolls. `scrollY` is the new scroll offset,
 * already kept in bounds. `deltaY` is how far it moves from the current offset.
 * To just track the offset, for example to place floating UI, observe at
 * priority `0`.
 *
 * Scrolls made by code (`scrollToPosition`, keeping the view steady, clearing
 * the document) fire after the page moved, with `source: "programmatic"`. Their
 * return value is ignored, so only user scrolls can be stopped.
 *
 * @group Built-in actions
 */
export const SCROLL = action<{
  scrollY: number;
  deltaY: number;
  source: "user" | "programmatic";
}>("scroll");

/**
 * The editor wants a context menu. It fires on right-click, on the keyboard
 * shortcut, and on a touch long-press. The editor draws no menu itself. Observe
 * this, show your own menu, and return `true`.
 *
 * The keyboard shortcuts are Cmd+Enter (Ctrl+Enter off Apple devices),
 * Shift+F10 and the Menu key. From the keyboard, `x` and `y` sit at the caret.
 *
 * - `x` and `y` are canvas coordinates. Add your container's position to place
 *   the menu.
 * - `hasSelection` says whether a range is selected.
 * - `point` is the spot the menu is about, when one was found. For a
 *   right-click it is the spot under the pointer. For the keyboard and touch it
 *   is the caret, or the moving end of a selection. Pass it to
 *   `query.block(point)` or `query.marks(point)`. Inside structured content it
 *   names only the block. Over a block with no text and no caret it is missing.
 *
 * While your menu is open, the editor ignores key presses, so your menu handles
 * arrows, Enter and Escape. On touch, the finger's moves and lift go to
 * {@link CONTEXT_MENU_POINTER_MOVE} and {@link CONTEXT_MENU_RELEASE} instead of
 * scrolling or selecting. Dispatch {@link CLOSE_CONTEXT_MENU} when you close
 * the menu.
 *
 * @group Built-in actions
 */
export const OPEN_CONTEXT_MENU = action<{
  x: number;
  y: number;
  hasSelection: boolean;
  /**
   * Document point under the pointer (or the caret for keyboard/touch opens),
   * when one resolved.
   */
  point?: DocPoint;
}>("open-context-menu");

/**
 * A touch drag moved while a host context menu is capturing the pointer (see
 * {@link OPEN_CONTEXT_MENU}). Payload is the raw viewport client point so the
 * host can hit-test its menu items (e.g. `document.elementFromPoint`) and update
 * its own hover highlight. Observe-only.
 *
 * @group Built-in actions
 */
export const CONTEXT_MENU_POINTER_MOVE = action<{
  clientX: number;
  clientY: number;
}>("context-menu-pointer-move");

/**
 * The finger lifted while a host context menu held the pointer. The payload is
 * where it lifted, in viewport client coordinates. Run the menu item under that
 * point, if there is one. Observe-only.
 *
 * @group Built-in actions
 */
export const CONTEXT_MENU_RELEASE = action<{
  clientX: number;
  clientY: number;
}>("context-menu-release");

/**
 * The context menu should close. The editor sends it when the menu is
 * cancelled: a scroll, a click or tap elsewhere, a new selection. Observe it to
 * hide your menu.
 *
 * Dispatch it yourself when your menu closes for any other reason, like picking
 * an item or pressing Escape. Until it fires, the editor treats your menu as
 * open. It ignores key presses and sends touch drags to the menu.
 *
 * @group Built-in actions
 */
export const CLOSE_CONTEXT_MENU = action("close-context-menu");

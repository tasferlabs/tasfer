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
import type { EditorState, Operation, SlashAction } from "./state-types";

/**
 * A typed action identifier. Carries no state (the `_p` field is phantom —
 * type-only, never read at runtime), so it's safe to declare as a module-level
 * constant and share across instances, exactly like a `defineNode` spec.
 */
export interface Action<P = void> {
  /** Human-readable name, for debugging only — identity is by reference. */
  readonly name: string;
  /** @internal Phantom marker threading the payload type through the API. */
  readonly _p?: P;
}

/**
 * A mutation action's handler. Receives the editor's {@link ChangeApi} plus the
 * payload, so an observer can contribute edits to the SAME transaction as the
 * default. Return `true` to override — claim the action and skip the default
 * mutation; return `false`/`void` to observe (queued edits still commit).
 */
export type MutationHandler<P = void> = (
  c: ChangeApi,
  payload: P,
) => boolean | void;

/** The default mutation carried by a {@link MutationAction} (handler-shaped). */
export type Mutator<P = void> = MutationHandler<P>;

/**
 * A action whose default behavior is a document mutation. Unlike a plain
 * {@link Action}, dispatching it runs the default plus every observer inside
 * ONE `change()` — one undo entry, one broadcast, one `on("change")`. It is
 * still a `Action<P>`, so it also flows through `run`/schema shortcuts.
 */
export interface MutationAction<P = void> extends Action<P> {
  readonly mutate: Mutator<P>;
}

/**
 * Declare a action. `name` is for debugging only — identity is by reference, so
 * two actions never alias by it. Pass a `mutate` function to make it a
 * {@link MutationAction}: its default behavior is a document mutation that
 * `editor.dispatch` runs (with every observer) inside one undoable transaction.
 * Either form is safe as a shared module-level constant — a `mutate` must be
 * pure with respect to editor instances (it only touches the {@link ChangeApi}
 * it's handed).
 */
export function action<P = void>(name: string): Action<P>;
export function action<P = void>(
  name: string,
  mutate: Mutator<P>,
): MutationAction<P>;
export function action<P = void>(
  name: string,
  mutate?: Mutator<P>,
): Action<P> | MutationAction<P> {
  return mutate ? { name, mutate } : { name };
}

/** Narrow a action to a mutation action (dispatch/run use this to pick a path). */
export function isMutationAction<P>(c: Action<P>): c is MutationAction<P> {
  return typeof (c as Partial<MutationAction<P>>).mutate === "function";
}

/**
 * The `{ state, ops }` pair every editor action produces — the lower-level
 * currency a {@link StateAction} trades in. `ops` is the CRDT operations the
 * transform emitted (empty for a pure cursor/selection move).
 */
export interface StateResult {
  state: EditorState;
  ops: Operation[];
}

/**
 * A state action's default behavior: a pure transform over the whole
 * {@link EditorState}. This is the *low-level* action shape — the same
 * `(state) => { state, ops }` currency the event pipeline already speaks, so it
 * can express things a {@link MutationAction}'s {@link ChangeApi} can't, like a
 * cursor/selection move that emits no ops. A {@link MutationAction} is sugar
 * layered above this for the document-mutation case.
 */
export type StateMutator<P = void> = (
  state: EditorState,
  payload: P,
) => StateResult;

/**
 * A state action's observer/override handler. Receives the current working
 * state (already threaded through higher-priority handlers) plus the payload.
 * Return a {@link StateResult} to contribute changes; add `handled: true` to
 * claim the action and skip the default transform; return `void` to observe
 * without changing anything (and pass through to lower-priority handlers).
 */
export type StateHandler<P = void> = (
  state: EditorState,
  payload: P,
) => (StateResult & { handled?: boolean }) | void;

/**
 * A action whose default behavior is a pure {@link StateMutator}. Dispatched
 * through {@link ActionBus.dispatchState} — the event pipeline threads its
 * `{ state, ops }` forward and commits it, rather than the live editor's
 * `change()`. Still a `Action<P>`, so it shares the same handler registry.
 */
export interface StateAction<P = void> extends Action<P> {
  readonly transform: StateMutator<P>;
}

/**
 * Declare a state action (see {@link StateAction}). `name` is for debugging
 * only — identity is by reference. The `transform` must be pure with respect to
 * editor instances (it only reads/derives from the `state` it's handed).
 */
export function stateAction<P = void>(
  name: string,
  transform: StateMutator<P>,
): StateAction<P> {
  return { name, transform };
}

/** Narrow a action to a state action (dispatch picks the pure-transform path). */
export function isStateAction<P>(c: Action<P>): c is StateAction<P> {
  return typeof (c as Partial<StateAction<P>>).transform === "function";
}

/**
 * A action handler. Return `true` to mark the action handled and stop
 * propagation (the editor's lower-priority default is skipped); return
 * `false`/`void` to observe and pass through to lower-priority handlers.
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
   * Run `action`'s handlers high→low priority, stopping at the first that
   * returns `true`. Returns whether any handler claimed it.
   */
  dispatch<P>(action: Action<P>, ...args: DispatchArgs<P>): boolean;
  /**
   * Run a {@link StateAction}: thread `state` through its observers (high→low
   * priority) and, unless one claims it (`handled: true`), its default
   * transform — accumulating every emitted op — and return the resulting
   * `{ state, ops }`. This is the pure-functional sibling of {@link dispatch}:
   * the event pipeline calls it with the working state and commits the result.
   */
  dispatchState<P>(
    action: StateAction<P>,
    state: EditorState,
    ...args: DispatchArgs<P>
  ): StateResult;
  /**
   * Registered handlers for `action`, high→low priority. For drivers that
   * invoke handlers with a non-standard signature — mutation actions thread a
   * {@link ChangeApi} through one transaction instead of going via `dispatch`.
   */
  handlersFor<P>(action: Action<P>): readonly ActionHandler<P>[];
}

interface Registered {
  handler: ActionHandler<unknown>;
  priority: number;
}

export function createActionBus(): ActionBus {
  const handlers = new Map<Action<unknown>, Registered[]>();
  return {
    register(action, handler, priority = 0) {
      const list = handlers.get(action) ?? [];
      const entry: Registered = {
        handler: handler as ActionHandler<unknown>,
        priority,
      };
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
      if (!claimed) {
        const r = action.transform(working.state, payload as never);
        working = { state: r.state, ops: working.ops.concat(r.ops) };
      }
      return working;
    },
    handlersFor(action) {
      const list = handlers.get(action as Action<unknown>) ?? [];
      return list.map(
        (e) => e.handler,
      ) as readonly ActionHandler<unknown>[] as never;
    },
  };
}

// ─── Built-in actions ─────────────────────────────────────────────────────

/**
 * A link was activated (Cmd/Ctrl-click on a `link` mark). Payload: the URL.
 * The editor registers a default handler (open in a new tab) at
 * {@link DEFAULT_ACTION_PRIORITY}; a host can register a higher-priority
 * handler that returns `true` to route the link itself (e.g. native nav).
 */
export const OPEN_LINK = action<{ url: string }>("open-link");

/** A touch cursor-drag gesture began. Observe-only (no editor default). */
export const CURSOR_DRAG_START = action("cursor-drag-start");

/** The touch-dragged caret crossed a character/line boundary. Observe-only. */
export const CURSOR_DRAG_BOUNDARY = action("cursor-drag-boundary");

/** A touch cursor-drag gesture ended (finger lifted). Observe-only. */
export const CURSOR_DRAG_END = action("cursor-drag-end");

/**
 * A held region drag (selection handle, image resize, scrollbar, …) promoted
 * to an active drag. `intensity` is the region's declared interaction salience
 * (see `RegionDragSpec.activationIntensity`); a host maps it to haptics, sound,
 * etc. Observe-only.
 */
export const REGION_DRAG_START = action<{
  regionId: string;
  intensity: "light" | "medium" | "heavy";
}>("region-drag-start");

/**
 * The slash-action menu is open and the user pressed an up/down arrow. The
 * engine owns *opening* the menu and the `/filter` text, but not the action
 * list — that lives in the host UI. This relays the keypress so the host moves
 * its own highlight. Observe-only (no editor default); the engine consumes the
 * key regardless so the caret doesn't move.
 */
export const SLASH_NAVIGATE = action<{ direction: "up" | "down" }>(
  "slash-navigate",
);

/**
 * The slash-action menu is open and the user pressed Enter. The host calls
 * `confirm` synchronously with its currently-selected action; the engine then
 * applies it through its normal edit path — so the engine stays the sole writer
 * of editor state and there's no mid-frame clobber from the host callback. A
 * host claims the action by returning `true`; if none does (e.g. an empty
 * filtered list), the engine closes the menu.
 */
export const SLASH_CONFIRM = action<{
  confirm: (action: SlashAction) => void;
}>("slash-confirm");

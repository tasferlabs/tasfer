/**
 * Command bus — a small, Lexical-style dispatch primitive that lets hosts and
 * plugins hook the editor's imperative actions without the engine knowing who
 * is listening. It sits alongside the schema's `defineNode` / `defineMark` as a
 * third extension primitive: `defineCommand` declares a typed action,
 * `editor.dispatch` fires it, `editor.registerCommand` listens.
 *
 * Two usage patterns fall out of one mechanism (priority + a "handled" return):
 *   - **override** — return `true` to claim the command and stop propagation,
 *     skipping the editor's built-in default (e.g. a native shell taking over
 *     {@link OPEN_LINK} to route the URL itself).
 *   - **observe**  — return `false`/`void` to react and let dispatch continue
 *     to lower-priority handlers, including the default (e.g. haptics reacting
 *     to {@link REGION_DRAG_START}).
 *
 * Naming convention: commands name what the editor *did* (`open-link`,
 * `region-drag-start`), never what a consumer does with it (no "haptic"
 * command). Consumers map those actions to their own effects.
 *
 * The handler registry is per editor instance (`createCommandBus`, carried on
 * `EditorState.commandBus` like `nodes`/`marks`) — never a module global — so
 * two editors on a page keep independent listeners.
 */

import type { SlashCommand } from "./state-types";

/**
 * A typed command identifier. Carries no state (the `_p` field is phantom —
 * type-only, never read at runtime), so it's safe to declare as a module-level
 * constant and share across instances, exactly like a `defineNode` spec.
 */
export interface Command<P = void> {
  /** Human-readable name, for debugging only — identity is by reference. */
  readonly name: string;
  /** @internal Phantom marker threading the payload type through the API. */
  readonly _p?: P;
}

/** Declare a command. `name` is for debugging; two commands never alias by it. */
export function defineCommand<P = void>(name: string): Command<P> {
  return { name };
}

/**
 * A command handler. Return `true` to mark the command handled and stop
 * propagation (the editor's lower-priority default is skipped); return
 * `false`/`void` to observe and pass through to lower-priority handlers.
 */
export type CommandHandler<P = void> = (payload: P) => boolean | void;

/** Trailing args `dispatch` takes after the command: none for `void` payloads. */
export type DispatchArgs<P> = [P] extends [void] ? [] : [payload: P];

/**
 * Priority of the editor's built-in default handlers. Below any host handler
 * (which default to `0`), so a host always gets first refusal and can override
 * a default by returning `true`.
 */
export const DEFAULT_COMMAND_PRIORITY = -Infinity;

export interface CommandBus {
  /**
   * Register `handler` for `command`. Higher `priority` runs first (default
   * `0`); ties run in registration order. Returns an unsubscribe function.
   */
  register<P>(
    command: Command<P>,
    handler: CommandHandler<P>,
    priority?: number,
  ): () => void;
  /**
   * Run `command`'s handlers high→low priority, stopping at the first that
   * returns `true`. Returns whether any handler claimed it.
   */
  dispatch<P>(command: Command<P>, ...args: DispatchArgs<P>): boolean;
}

interface Registered {
  handler: CommandHandler<unknown>;
  priority: number;
}

export function createCommandBus(): CommandBus {
  const handlers = new Map<Command<unknown>, Registered[]>();
  return {
    register(command, handler, priority = 0) {
      const list = handlers.get(command) ?? [];
      const entry: Registered = {
        handler: handler as CommandHandler<unknown>,
        priority,
      };
      // Keep the list sorted high→low so dispatch is a straight walk. A new
      // entry goes before the first strictly-lower one — so equal priorities
      // preserve registration order (the new one runs after existing peers).
      const at = list.findIndex((e) => e.priority < priority);
      if (at === -1) list.push(entry);
      else list.splice(at, 0, entry);
      handlers.set(command, list);
      return () => {
        const arr = handlers.get(command);
        if (!arr) return;
        const i = arr.indexOf(entry);
        if (i > -1) arr.splice(i, 1);
      };
    },
    dispatch(command, ...args) {
      const list = handlers.get(command);
      if (!list || list.length === 0) return false;
      const payload = (args as unknown[])[0];
      // Walk a copy so a handler that (un)registers mid-dispatch can't shift
      // the array out from under the loop.
      for (const { handler } of list.slice()) {
        if (handler(payload) === true) return true;
      }
      return false;
    },
  };
}

// ─── Built-in commands ─────────────────────────────────────────────────────

/**
 * A link was activated (Cmd/Ctrl-click on a `link` mark). Payload: the URL.
 * The editor registers a default handler (open in a new tab) at
 * {@link DEFAULT_COMMAND_PRIORITY}; a host can register a higher-priority
 * handler that returns `true` to route the link itself (e.g. native nav).
 */
export const OPEN_LINK = defineCommand<{ url: string }>("open-link");

/** A touch cursor-drag gesture began. Observe-only (no editor default). */
export const CURSOR_DRAG_START = defineCommand("cursor-drag-start");

/** The touch-dragged caret crossed a character/line boundary. Observe-only. */
export const CURSOR_DRAG_BOUNDARY = defineCommand("cursor-drag-boundary");

/** A touch cursor-drag gesture ended (finger lifted). Observe-only. */
export const CURSOR_DRAG_END = defineCommand("cursor-drag-end");

/**
 * A held region drag (selection handle, image resize, scrollbar, …) promoted
 * to an active drag. `intensity` is the region's declared interaction salience
 * (see `RegionDragSpec.activationIntensity`); a host maps it to haptics, sound,
 * etc. Observe-only.
 */
export const REGION_DRAG_START = defineCommand<{
  regionId: string;
  intensity: "light" | "medium" | "heavy";
}>("region-drag-start");

/**
 * The slash-command menu is open and the user pressed an up/down arrow. The
 * engine owns *opening* the menu and the `/filter` text, but not the command
 * list — that lives in the host UI. This relays the keypress so the host moves
 * its own highlight. Observe-only (no editor default); the engine consumes the
 * key regardless so the caret doesn't move.
 */
export const SLASH_NAVIGATE = defineCommand<{ direction: "up" | "down" }>(
  "slash-navigate",
);

/**
 * The slash-command menu is open and the user pressed Enter. The host calls
 * `confirm` synchronously with its currently-selected command; the engine then
 * applies it through its normal edit path — so the engine stays the sole writer
 * of editor state and there's no mid-frame clobber from the host callback. A
 * host claims the command by returning `true`; if none does (e.g. an empty
 * filtered list), the engine closes the menu.
 */
export const SLASH_CONFIRM = defineCommand<{
  confirm: (command: SlashCommand) => void;
}>("slash-confirm");

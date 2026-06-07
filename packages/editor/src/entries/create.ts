import { type Block, loadPage } from "../serlization/loadPage";
import type { Editor } from "./editor";
import { mountEditor, type MountEditorOptions } from "./mount";

export interface CreateEditorOptions extends MountEditorOptions {
  /** The host element the canvas mounts into. Sized to fill this element. */
  element: HTMLElement;
  /** Initial document as a Markdown string. Ignored when `blocks` is provided. */
  value?: string;
  /**
   * Pre-parsed blocks to mount instead of `value` (e.g. restored from a
   * snapshot). Takes precedence over `value`.
   */
  blocks?: Block[];
  /** Focus the editor and drop a caret in on mount. Default false. */
  autofocus?: boolean;
}

/**
 * The handle returned by {@link createEditor}: the full {@link Editor} command
 * surface plus the mount-level conveniences (focus / blur / teardown / portal).
 *
 * Its `destroy()` performs the *complete* teardown — canvas layers, global
 * listeners, the portal, and the render loop — so always call it when removing
 * the editor (it supersedes the core `Editor.destroy`).
 */
export interface CypherEditor extends Editor {
  /** Container to mount React popovers/overlays into (slash menu, link editor). */
  readonly portalContainer: HTMLDivElement;
  /** Focus the editor, placing a caret if there isn't one yet. */
  focus: () => void;
  /** Blur the editor / dismiss the soft keyboard. */
  blur: () => void;
  /** Refocus the hidden input (e.g. after closing a dialog or drawer). */
  refocus: () => void;
  /** Feed the current soft-keyboard height (px) for mobile layout. */
  setKeyboardHeight: (height: number) => void;
  /** Full teardown: canvas layers, global listeners, portal, render loop. */
  destroy: () => void;
}

/**
 * Convenience constructor: parse Markdown, mount the canvas editor into an
 * element, and return a single handle that merges the editor command API with
 * the mount lifecycle.
 *
 * A thin wrapper over `loadPage` + `mountEditor` — reach for `mountEditor`
 * directly when you want the lower-level split (e.g. to keep the `MountedEditor`
 * and `Editor` handles separate).
 *
 * @example
 * const editor = createEditor({
 *   element: document.querySelector("#editor")!,
 *   value: "# Hello\n\nStart typing — **markdown** shortcuts work.",
 *   autofocus: true,
 * });
 *
 * editor.on("change", () => localStorage.setItem("draft", editor.getMarkdown()));
 * // …later
 * editor.destroy();
 */
export function createEditor(options: CreateEditorOptions): CypherEditor {
  const { element, value, blocks, autofocus, ...mountOptions } = options;

  // `blocks` wins; otherwise parse `value` (loadPage always returns ≥1 block,
  // so an empty/omitted string is a valid blank document).
  const initialBlocks = blocks ?? loadPage(value ?? "").blocks;

  const mounted = mountEditor(element, initialBlocks, mountOptions);
  const { editor } = mounted;

  const focus = () => {
    mounted.refocus();
    editor.setInitialCursor();
  };

  if (autofocus) focus();

  return {
    // Spread the core editor command surface (toggleBold, undo, on,
    // getMarkdown, commands, chain, sync methods, …) onto the returned handle.
    ...editor,
    // Re-expose `state` as a live getter: object spread above evaluates the
    // core getter once and would otherwise freeze it to a stale snapshot.
    get state() {
      return editor.state;
    },
    portalContainer: mounted.portalContainer,
    refocus: mounted.refocus,
    setKeyboardHeight: mounted.setKeyboardHeight,
    focus,
    blur: mounted.blurInput,
    // Override the core `editor.destroy` with the full mount teardown.
    // (mounted.destroy calls the original editor.destroy internally — the
    // spread copies a reference, it isn't reassigned, so there's no recursion.)
    destroy: mounted.destroy,
  };
}

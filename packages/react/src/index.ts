/**
 * @tasfer/react — React 19 bindings for the headless `@tasfer/editor`
 * canvas editor.
 *
 * Three pieces, all per-instance (no module-level state — multiple editors can
 * live on one page):
 *   - {@link useEditor} — create and own a `TasferEditor`, mounting it into a
 *     `<div>` you render through the returned `containerRef`.
 *   - {@link Editor} — a drop-in component wrapping `useEditor` that renders the
 *     host element for you and reports the editor via `onReady`.
 *   - {@link useEditorState} / {@link useEditorMarkdown} — `useSyncExternalStore`
 *     subscriptions that re-render on edits (great for toolbars / live preview).
 *
 * Editor options are read once at mount; reconfigure at runtime through the
 * imperative `TasferEditor` handle (`setTheme`, `setMarkdown`, `change`, …).
 *
 * @example
 * import { Editor, useEditorState } from "@tasfer/react";
 *
 * function App() {
 *   return <Editor markdown="# Hello" autofocus style={{ height: "100vh" }} />;
 * }
 */

export { useEditor } from "./useEditor";
export type { UseEditorOptions, UseEditorResult } from "./useEditor";

export { Editor } from "./Editor";
export type { EditorProps } from "./Editor";

export { useEditorMarkdown, useEditorState } from "./useEditorState";
export type { EditorStateValue } from "./useEditorState";

// Re-export the engine types hosts most often reference alongside these
// bindings, so a consumer can import everything from one place.
export type {
  ChangeTransaction,
  CreateEditorOptions,
  TasferEditor,
  Doc,
  EditorStateSnapshot,
} from "@tasfer/editor";

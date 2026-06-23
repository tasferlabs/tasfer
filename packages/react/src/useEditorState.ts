import type { Doc, EditorStateSnapshot } from "@cypherkit/editor";
import type { CypherEditor } from "@cypherkit/editor";
import { useCallback, useRef, useSyncExternalStore } from "react";

/**
 * Live editor-state snapshot returned by {@link useEditorState}: the engine's
 * `editor.state` ({@link EditorStateSnapshot} — selection, active marks, the
 * caret block type, undo/redo readiness, focus) plus the attached `doc`,
 * surfaced reactively. Defined as an intersection so it stays in lockstep with
 * the engine snapshot. `null` when no editor is attached yet.
 */
export type EditorStateValue = EditorStateSnapshot & {
  /** The CRDT document the editor renders and edits. */
  readonly doc: Doc;
};

/**
 * Subscribe to a {@link CypherEditor}'s state and re-render on changes.
 *
 * Tracks both document content (`"change"`) and caret/selection movement
 * (`"selectionchange"`), returning the editor's `{ selection, activeMarks, doc }`
 * snapshot — ideal for lighting up a toolbar or status bar. Returns `null` while
 * `editor` is `null` (e.g. before {@link useEditor} has mounted).
 *
 * Backed by `useSyncExternalStore`. Because `editor.state` builds a *fresh*
 * object on every read, the snapshot is cached in a ref and only refreshed when
 * a subscribed event actually fires — otherwise `getSnapshot` would return a new
 * reference each call and loop forever.
 *
 * @example
 * const { editor } = useEditor({ markdown: "**bold**" });
 * const state = useEditorState(editor);
 * const isBold = state?.activeMarks.has("strong") ?? false;
 */
export function useEditorState(
  editor: CypherEditor | null,
): EditorStateValue | null {
  // The last snapshot handed to React. Refreshed inside the subscribe callbacks
  // (and lazily in getSnapshot when the editor identity changes) so that
  // getSnapshot returns a stable reference between events.
  const snapshotRef = useRef<EditorStateValue | null>(null);
  // The editor the cached snapshot belongs to, so a swapped editor invalidates
  // a stale cache instead of leaking the previous instance's state.
  const editorRef = useRef<CypherEditor | null>(null);

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!editor) return () => {};

      const refresh = () => {
        snapshotRef.current = editor.state;
        editorRef.current = editor;
        onStoreChange();
      };

      // Prime the cache for this editor before the first getSnapshot read.
      refresh();

      const offChange = editor.on("change", refresh);
      const offSelection = editor.on("selectionchange", refresh);
      return () => {
        offChange();
        offSelection();
      };
    },
    [editor],
  );

  const getSnapshot = useCallback((): EditorStateValue | null => {
    if (!editor) return null;
    // Recompute once when the cache is empty or belongs to a different editor;
    // otherwise return the stable cached reference so React doesn't loop.
    if (snapshotRef.current === null || editorRef.current !== editor) {
      snapshotRef.current = editor.state;
      editorRef.current = editor;
    }
    return snapshotRef.current;
  }, [editor]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Subscribe to a {@link CypherEditor}'s Markdown projection, re-rendering
 * whenever the document content changes (`"change"`). Returns `""` while
 * `editor` is `null`.
 *
 * The Markdown string is cached and only re-serialized on a `"change"` event, so
 * `getSnapshot` stays referentially stable between edits.
 *
 * @example
 * const { editor } = useEditor({ markdown: "# Title" });
 * const markdown = useEditorMarkdown(editor); // "# Title", updates as you type
 */
export function useEditorMarkdown(editor: CypherEditor | null): string {
  const markdownRef = useRef<string>("");
  const editorRef = useRef<CypherEditor | null>(null);

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!editor) return () => {};

      const refresh = () => {
        markdownRef.current = editor.getMarkdown();
        editorRef.current = editor;
        onStoreChange();
      };

      refresh();
      return editor.on("change", refresh);
    },
    [editor],
  );

  const getSnapshot = useCallback((): string => {
    if (!editor) return "";
    if (editorRef.current !== editor) {
      markdownRef.current = editor.getMarkdown();
      editorRef.current = editor;
    }
    return markdownRef.current;
  }, [editor]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

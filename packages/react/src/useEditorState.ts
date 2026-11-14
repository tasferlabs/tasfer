import type {
  BaseSchemaDefinition,
  TasferEditor,
  Doc,
  EditorStateSnapshot,
  SchemaDefinition,
} from "@tasfer/editor";
import { useCallback, useRef, useSyncExternalStore } from "react";

/**
 * What {@link useEditorState} returns: everything in `editor.state`
 * ({@link EditorStateSnapshot}: selection, active marks, whether undo and redo
 * can run, focus, mode) plus the editor's `doc`.
 */
// Defined as an intersection so it stays in lockstep with the engine snapshot.
export type EditorStateValue<
  D extends SchemaDefinition = BaseSchemaDefinition,
> = EditorStateSnapshot & {
  /** The document the editor shows and edits. */
  readonly doc: Doc<D>;
};

/**
 * Read the editor's state ({@link EditorStateValue}) and re-render when it
 * changes. It updates when the document changes and when the caret or selection
 * moves, so it suits a toolbar or a status bar. Returns `null` while `editor`
 * is `null`, for example before {@link useEditor} has mounted.
 *
 * @example
 * const { editor } = useEditor({ markdown: "**bold**" }); const state =
 * useEditorState(editor); const isBold = state?.activeMarks.has("strong") ??
 * false;
 */
// Backed by useSyncExternalStore. editor.state builds a fresh object on every
// read, so the snapshot is cached in a ref and only refreshed when a subscribed
// event fires; otherwise getSnapshot would return a new reference each call and
// loop forever.
export function useEditorState<
  D extends SchemaDefinition = BaseSchemaDefinition,
>(editor: TasferEditor<D> | null): EditorStateValue<D> | null {
  // The last snapshot handed to React. Refreshed inside the subscribe callbacks
  // (and lazily in getSnapshot when the editor identity changes) so that
  // getSnapshot returns a stable reference between events.
  const snapshotRef = useRef<EditorStateValue<D> | null>(null);
  // The editor the cached snapshot belongs to, so a swapped editor invalidates
  // a stale cache instead of leaking the previous instance's state.
  const editorRef = useRef<TasferEditor<D> | null>(null);

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

  const getSnapshot = useCallback((): EditorStateValue<D> | null => {
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
 * Read the editor's content as Markdown, and re-render whenever the document
 * changes. Returns `""` while `editor` is `null`. The Markdown is rebuilt only
 * when the document changes, not on every render.
 *
 * @example
 * const { editor } = useEditor({ markdown: "# Title" }); const markdown =
 * useEditorMarkdown(editor); // "# Title", updates as you type
 */
// Cached so getSnapshot stays referentially stable between edits.
export function useEditorMarkdown<
  D extends SchemaDefinition = BaseSchemaDefinition,
>(editor: TasferEditor<D> | null): string {
  const markdownRef = useRef<string>("");
  const editorRef = useRef<TasferEditor<D> | null>(null);

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

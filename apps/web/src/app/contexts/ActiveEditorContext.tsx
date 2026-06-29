import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { MountedEditor as MountedEditorInstance } from "@cypherkit/editor";

/**
 * The live editor handle currently driving the page, or `null` when no editor
 * is mounted (loading / error / non-editor route). This is the same
 * {@link MountedEditorInstance.editor} handle the host holds; the primary
 * {@link MountedEditor} on the editor page registers it here on mount and
 * clears it on unmount (readonly previews never register — see
 * `EditorPage`/`MountedEditor`).
 *
 * Its only consumer today is the staging {@link DevToolbar}'s "Editor" tab,
 * which inspects live document/CRDT state for debugging. Kept in a dedicated,
 * scoped React context (not a module global) so it stays per app-instance and
 * never clobbers a second editor mounted elsewhere on the page.
 */
export type ActiveEditorHandle = MountedEditorInstance["editor"];

interface ActiveEditorContextType {
  readonly editor: ActiveEditorHandle | null;
  readonly setEditor: (editor: ActiveEditorHandle | null) => void;
}

const ActiveEditorContext = createContext<ActiveEditorContextType | undefined>(
  undefined,
);

export function ActiveEditorProvider({ children }: { children: ReactNode }) {
  const [editor, setEditor] = useState<ActiveEditorHandle | null>(null);
  const value = useMemo(() => ({ editor, setEditor }), [editor]);
  return (
    <ActiveEditorContext.Provider value={value}>
      {children}
    </ActiveEditorContext.Provider>
  );
}

/**
 * Read the live editor handle (and its setter). Returns `null` for `editor`
 * until the page's editor mounts. Throws if used outside the provider, so a
 * missing provider surfaces as a clear error rather than a silent `null`.
 */
export function useActiveEditor(): ActiveEditorContextType {
  const ctx = useContext(ActiveEditorContext);
  if (ctx === undefined) {
    throw new Error(
      "useActiveEditor must be used within an ActiveEditorProvider",
    );
  }
  return ctx;
}

import {
  createEditor,
  type CreateEditorBaseOptions,
  type CreateEditorContent,
  type CreateEditorOptions,
  type CypherEditor,
} from "@cypherkit/editor";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";

/**
 * Options for {@link useEditor}: every {@link CreateEditorOptions} field except
 * `element`, which the hook owns (it mounts the canvas into a `<div>` it manages
 * through `containerRef`).
 *
 * Built by omitting `element` from the *base* options and re-intersecting the
 * {@link CreateEditorContent} union — NOT `Omit<CreateEditorOptions, "element">`,
 * because `Omit` over a union collapses it (`keyof` a union is the intersection
 * of its members' keys), which would silently drop the markdown/blocks/doc
 * exclusivity at the React layer.
 */
export type UseEditorOptions = Omit<CreateEditorBaseOptions, "element"> &
  CreateEditorContent;

/**
 * Return value of {@link useEditor}.
 */
export interface UseEditorResult {
  /**
   * Attach to the host element the editor mounts into:
   * `<div ref={containerRef} />`. The editor sizes itself to fill this element,
   * so the host must give it a height (e.g. via CSS) — an unsized div renders
   * nothing visible.
   */
  containerRef: RefObject<HTMLDivElement | null>;
  /**
   * The live editor handle, or `null` before the first effect runs (i.e. on the
   * initial render, and on the server). Drive imperative changes through this —
   * `editor.setTheme(...)`, `editor.setMarkdown(...)`, `editor.change(...)`, etc.
   */
  editor: CypherEditor | null;
}

// `useLayoutEffect` warns when run on the server (no DOM). The editor only ever
// mounts in the browser, so fall back to `useEffect` where `window` is absent.
const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

/**
 * Create and own a {@link CypherEditor}, mounting it into a `<div>` you render
 * via the returned `containerRef`.
 *
 * The editor is created exactly **once per mount**, in a layout effect, and torn
 * down (`editor.destroy()`) on unmount. This is correct under React 18/19
 * StrictMode's double-invoke: each create is paired with its destroy.
 *
 * Option changes **after** the initial mount are intentionally **not** reapplied
 * — re-running `createEditor` would throw away the document and CRDT state. To
 * change things at runtime, mutate the live editor imperatively (e.g.
 * `editor.setTheme(...)`, `editor.setMarkdown(...)`). The latest options are
 * read at mount time, so prop drift between render and the effect is handled.
 *
 * @example
 * function MyEditor() {
 *   const { containerRef, editor } = useEditor({ markdown: "# Hello" });
 *   useEffect(() => {
 *     if (editor) editor.focus("end");
 *   }, [editor]);
 *   return <div ref={containerRef} style={{ height: "100%" }} />;
 * }
 */
export function useEditor(options: UseEditorOptions): UseEditorResult {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [editor, setEditor] = useState<CypherEditor | null>(null);

  // Hold the latest options in a ref so the mount-only effect reads current
  // values at create time without listing `options` in its deps (which would
  // recreate the editor on every render and destroy its state).
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useIsomorphicLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    // `optionsRef.current` is a `UseEditorOptions` — itself the discriminated
    // content-source union, so the caller already satisfied the
    // markdown/blocks/doc exclusivity at their own call site. Object-spreading a
    // union widens away the discriminant (TS can no longer prove which variant
    // survived `{ ...x }`), so we reassert the type here. `createEditor`'s
    // runtime guard still backstops a genuinely-conflicting object.
    const instance = createEditor({
      ...optionsRef.current,
      element,
    } as CreateEditorOptions);
    setEditor(instance);

    return () => {
      instance.destroy();
      setEditor(null);
    };
    // Mount-only: the editor is created once and reconfigured imperatively.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { containerRef, editor };
}

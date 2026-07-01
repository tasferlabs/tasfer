import { titleBlockWindow, type Doc } from "@cypherkit/editor";
import i18next from "i18next";
import {
  useCallback,
  useEffect,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { appSchema } from "../editorSchema";
import { cn } from "../lib/utils";
import { useEditorCore } from "./editorCore";

/**
 * The title schema: only `heading1` is creatable, with a small set of inline
 * marks. `restrict` keeps the FULL registry, so a title that already holds a
 * disallowed block (a collaborator's paste, a legacy doc) still RENDERS — only
 * new authoring is constrained.
 */
const titleSchema = appSchema.restrict({
  blocks: ["heading1"],
  marks: ["strong", "emphasis", "strike", "code"],
});

export interface TitleEditorProps {
  /**
   * The shared CRDT document whose TITLE block this edits (or renders) — the same
   * `Doc` the body editor is bound to. Editing here updates the body's first
   * heading live through the CRDT; this surface can never touch any other block.
   */
  doc: Doc;
  /** False mounts a read-only title (e.g. a card / draft preview). Default true. */
  editable?: boolean;
  /** Enter commits — e.g. close a dialog or advance focus to the body. */
  onSubmit?: () => void;
  /** Escape cancels — e.g. dismiss a dialog. */
  onCancel?: () => void;
  /** Placeholder for an empty title. Defaults to the localized "Title". */
  placeholder?: string;
  /** Focus and drop a caret at the end on mount. */
  autoFocus?: boolean;
  className?: string;
  /**
   * The canvas fills this element, so it must be sized. Defaults to roughly a
   * single title line; override for a taller or auto-growing title.
   */
  style?: CSSProperties;
}

/**
 * A compact editor bound to a shared `Doc` that shows and edits ONLY the
 * document's title block (its first text block). It is a windowed
 * ({@link titleBlockWindow}), restricted ({@link appSchema}.restrict) view over
 * the same doc the body renders, so it can never create, split, or merge blocks
 * and never mutates anything but the title — while staying live-synced with the
 * body through the CRDT, with zero extra collaboration wiring (sync/persistence
 * live on the shared doc).
 *
 * Reuse it as the edit-title dialog (editable), a draft / card title (read-only),
 * or anywhere a doc's title should be edited in isolation.
 */
export function TitleEditor({
  doc,
  editable = true,
  onSubmit,
  onCancel,
  placeholder,
  autoFocus,
  className,
  style,
}: TitleEditorProps) {
  // useEditorCore supplies the shared theme, strings, and live re-theming — the
  // same core the body PageEditor mounts on — so a title looks and behaves like
  // the body's heading. We add only the title-specific options: the single-block
  // window and the heading-only restricted schema.
  const { containerRef, editor } = useEditorCore({
    doc,
    schema: titleSchema,
    window: titleBlockWindow(),
    editable,
    ariaLabel: i18next.t("editor.titleAriaLabel", "Page title"),
    placeholder: {
      heading1: placeholder ?? i18next.t("common.title", "Title"),
    },
  });

  useEffect(() => {
    if (editor && autoFocus) editor.focus();
  }, [editor, autoFocus]);

  // A single-block window makes Enter inert in the engine (it can't split), so
  // the key bubbles here cleanly — map Enter to submit and Escape to cancel, the
  // way the old plain-input title behaved. preventDefault stops any stray newline.
  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        onSubmit?.();
      } else if (e.key === "Escape") {
        onCancel?.();
      }
    },
    [onSubmit, onCancel],
  );

  return (
    <div
      ref={containerRef}
      className={cn("cypher-title-editor", className)}
      style={{ height: "3rem", ...style }}
      onKeyDown={onKeyDown}
    />
  );
}

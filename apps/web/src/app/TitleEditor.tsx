import {
  titleBlockWindow,
  type Doc,
  type EditorTheme,
} from "@cypherkit/editor";
import { getFontMetrics, onFontsReady } from "@cypherkit/editor/internal";
import i18next from "i18next";
import {
  useCallback,
  useEffect,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { appSchema } from "../editorSchema";
import { getAppFontRegistry, onAppFontRegistryChange } from "../fonts";
import { cn } from "../lib/utils";
import { useEditorCore } from "./editorCore";
import useResponsive from "./hooks/useResponsive";
import { suppressFormattingToolbar } from "./mobileToolbarSuppression";

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

/**
 * The `Input` component's box metrics (see `components/ui/input.tsx`), which
 * this surface reproduces on canvas. They are authored in rem, exactly like the
 * component's Tailwind classes — `h-9` (2.25rem) box, `px-2.5` (0.625rem)
 * horizontal padding, typography `text-base` (1rem/1.5rem) dropping to
 * `md:text-sm` (0.875rem/1.25rem) on desktop — and resolved against the live
 * root font size in {@link titleInputTheme}, so the canvas follows a browser
 * font-size / rem-scale change the same way its DOM siblings do. Only the 1px
 * border is px-authored and never scales. Text weight/color are the input's
 * inherited defaults, not the page-heading style — the title should be
 * indistinguishable from a native text field.
 */
const INPUT_BOX = { height: 2.25, borderPx: 1, paddingX: 0.625 } as const;
const INPUT_TEXT = { fontSize: 1, lineHeight: 1.5 } as const; // text-base
const INPUT_TEXT_MD = { fontSize: 0.875, lineHeight: 1.25 } as const; // md:text-sm
const INPUT_FONT_WEIGHT = "normal";

/**
 * Theme overrides that make the title's `heading1` render exactly like the
 * `Input` component's text, deep-merged over {@link appEditorTheme} (colors,
 * fonts, and dark-mode re-theming are unaffected elsewhere).
 *
 * Vertical centering is computed, not hardcoded: the engine sizes a text line
 * to `max(fontSize × lineHeight, font bounding box)`, and Poppins's bounding
 * box is far taller than its em box (up to ~1.76em with Windows-style metrics)
 * — the caret is drawn that full box tall. Padding derived from the measured
 * metrics keeps the line box (and therefore the caret) centered inside the
 * fixed input height instead of overflowing and clipping.
 *
 * Recomputed (and re-pushed via `setTheme`) whenever an input dependency
 * changes: the `md` breakpoint, font faces finishing loading, the font
 * registry swapping stacks, or a dark-mode toggle changing the CSS variables
 * read here.
 */
function titleInputTheme(isDesktop: boolean): EditorTheme {
  // Placeholder in every empty state — a text field shows its placeholder
  // whether or not it is focused, unlike the body editor's caret-block ghosts.
  const placeholder = { showUnfocused: true };
  if (typeof document === "undefined") return { styles: { placeholder } };

  // Resolve the rem scale the moment the theme is built — every re-push
  // trigger (breakpoint, fonts, dark-mode class) recomputes from the current
  // root font size, keeping the canvas in step with its rem-sized DOM chrome.
  const rem =
    parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const text = isDesktop ? INPUT_TEXT_MD : INPUT_TEXT;
  const fontSize = text.fontSize * rem;
  const lineHeight = text.lineHeight * rem;
  const fonts = getAppFontRegistry();
  const metrics = getFontMetrics(
    fontSize,
    INPUT_FONT_WEIGHT,
    fonts.defaultFamily,
    fonts,
  );
  // Same fallbacks the engine's text layout uses when a browser reports no
  // font bounding box, so the padding math mirrors the real line box.
  const ascent = Number.isFinite(metrics.ascent)
    ? metrics.ascent
    : fontSize * 0.8;
  const descent = Number.isFinite(metrics.descent)
    ? metrics.descent
    : fontSize * 0.2;
  const lineBox = Math.max(lineHeight, ascent + descent);
  const innerHeight = INPUT_BOX.height * rem - 2 * INPUT_BOX.borderPx;
  const padY = Math.max(0, (innerHeight - lineBox) / 2);

  // The input's text and placeholder colors are the app-wide `--foreground` /
  // `--muted-foreground`, not the editor's heading/placeholder tokens — read
  // them here so the field matches sibling `Input`s exactly.
  const cs = getComputedStyle(document.documentElement);
  const foreground = cs.getPropertyValue("--foreground").trim();
  const mutedForeground = cs.getPropertyValue("--muted-foreground").trim();

  return {
    styles: {
      blocks: {
        heading1: {
          fontSize,
          fontWeight: INPUT_FONT_WEIGHT,
          lineHeight: lineHeight / fontSize,
          // Zero both block paddings: this surface mimics an <Input>, so all
          // vertical centering comes from the canvas padding computed above —
          // the page theme's prose space-above-headings must not leak in.
          paddingTop: 0,
          paddingBottom: 0,
          ...(foreground ? { color: foreground } : {}),
        },
      },
      canvas: {
        paddingTop: padY,
        paddingBottom: padY,
        paddingLeft: INPUT_BOX.paddingX * rem,
        paddingRight: INPUT_BOX.paddingX * rem,
      },
      // A native input's caret is a bare bar. The engine's touch drag handle
      // (stem + circle under the caret) extends ~13px below the caret, which
      // pokes out of this compact fixed-height box — and nothing hit-tests it,
      // so zeroing it only removes the drawing.
      cursor: { handleRadius: 0, handleStemHeight: 0 },
      placeholder: {
        ...placeholder,
        ...(mutedForeground ? { color: mutedForeground } : {}),
      },
    },
  };
}

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
  /**
   * Grow the canvas to fit the title's content (wrapping to multiple lines)
   * instead of filling a fixed-height container, and never render a scrollbar.
   * The container keeps the input chrome but only a minimum height — use for a
   * self-sizing title. Default false, which keeps the fixed single-line
   * input height.
   */
  autoHeight?: boolean;
  className?: string;
  /** Positions the field. Sizing comes from the input chrome classes. */
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
 * Visually it reproduces the `Input` component (`components/ui/input.tsx`) —
 * box chrome, focus ring, typography, placeholder behavior — so a title field
 * sits indistinguishably next to native inputs in a form or dialog.
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
  autoHeight,
  className,
  style,
}: TitleEditorProps) {
  const isDesktop = useResponsive("(min-width: 768px)");

  // useEditorCore supplies the shared theme, strings, and live re-theming — the
  // same core the body PageEditor mounts on. We add only the title-specific
  // options: the single-block window, the heading-only restricted schema, and
  // the Input-mirroring theme overrides.
  const { containerRef, editor } = useEditorCore({
    doc,
    schema: titleSchema,
    window: titleBlockWindow(),
    editable,
    autoHeight,
    theme: titleInputTheme(isDesktop),
    ariaLabel: i18next.t("editor.titleAriaLabel", "Page title"),
    placeholder: {
      heading1: placeholder ?? i18next.t("common.title", "Title"),
    },
  });

  // Keep the Input-mirroring overrides current after mount. The core's live
  // theming re-pushes tokens/fonts, but this surface's overrides also depend on
  // the breakpoint, the measured font metrics (which change when faces finish
  // loading or the registry swaps stacks), CSS variables that flip with the
  // `.dark` class, and the root font size (the rem scale all the box metrics
  // resolve against) — each re-push deep-merges over the core's theme. `style`
  // is observed alongside `class` so an app-set inline root font-size (a UI
  // scale setting) re-derives the rem metrics; a browser-level font-size change
  // has no event and is picked up on the next push.
  useEffect(() => {
    if (!editor) return;
    const push = () => editor.setTheme(titleInputTheme(isDesktop));
    push();
    const darkObserver = new MutationObserver(push);
    darkObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    const offFontsReady = onFontsReady(push);
    const offRegistry = onAppFontRegistryChange(push);
    return () => {
      darkObserver.disconnect();
      offFontsReady();
      offRegistry();
    };
  }, [editor, isDesktop]);

  // A single-line title has no block formatting, so while it holds focus the
  // mobile formatting toolbar (native iOS accessory / Android-web React bar,
  // both keyed to the keyboard rather than to the focused surface) must not
  // appear. Suppression is focus-scoped, not mount-scoped, so a future
  // always-mounted title bar beside the body won't starve the body's toolbar.
  useEffect(() => {
    if (!editor || !editable) return;
    let release: (() => void) | null = null;
    const offFocus = editor.on("focus", () => {
      release ??= suppressFormattingToolbar();
    });
    const offBlur = editor.on("blur", () => {
      release?.();
      release = null;
    });
    return () => {
      offFocus?.();
      offBlur?.();
      release?.();
    };
  }, [editor, editable]);

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
      // The Input component's chrome (border, radius, shadow, dark surface),
      // minus its px/py/text classes — spacing and typography are painted by
      // the canvas from the same metrics. Focus lands on the editor's hidden
      // input inside the container, so the ring uses focus-within.
      className={cn(
        "cypher-title-editor",
        "border-input dark:bg-input/30 w-full min-w-0 rounded-md border bg-transparent shadow-xs transition-[color,box-shadow] outline-none",
        editable &&
          "focus-within:border-ring focus-within:ring-ring/50 focus-within:ring-3",
        autoHeight ? "min-h-9" : "h-9",
        className,
      )}
      style={style}
      onKeyDown={onKeyDown}
    />
  );
}

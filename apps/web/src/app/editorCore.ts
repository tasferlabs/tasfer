/**
 * EditorCore — the shared editing primitive every editor instance in the app is
 * built on: one mount hook ({@link useEditorCore}) plus the localized strings,
 * theme, and fonts it renders with. Both the full-page {@link PageEditor} (the
 * body, the WYSIWYG business logic) and the compact {@link TitleEditor} mount
 * through this, so they look and behave identically and pick up new editor
 * features in one place.
 *
 * Note what is deliberately NOT here: collaboration and persistence. Those live
 * on the shared `Doc` (its op log, providers, and snapshot), so ANY editor bound
 * to that doc — full page or title window — syncs live for free, with no wiring
 * duplicated per surface.
 */

import {
  mergeTheme,
  type BaseSchemaDefinition,
  type EditorTheme,
  type SchemaDefinition,
} from "@cypherkit/editor";
import { type EditorStrings } from "@cypherkit/editor/internal";
import {
  useEditor,
  type CypherEditor,
  type UseEditorOptions,
  type UseEditorResult,
} from "@cypherkit/react";
import i18next from "i18next";
import { useEffect } from "react";
import { cssVarsToTheme } from "../editorTheme";
import { getAppFontRegistry, onAppFontRegistryChange } from "../fonts";

/**
 * Localized cross-node canvas strings (block placeholders). The
 * `@cypherkit/editor` package ships English defaults and no i18n library, so the
 * host passes translations at mount. Evaluated at mount time — fine, since the
 * language only changes on the Settings page where no editor is mounted; the
 * next mount picks up the new language.
 *
 * Strings owned by a single block type live on the node, not here — see
 * {@link editorNodeStrings}.
 */
export function editorStrings(): EditorStrings {
  return {
    placeholderHeading1: i18next.t("blocks.heading1"),
    placeholderHeading2: i18next.t("blocks.heading2"),
    placeholderHeading3: i18next.t("blocks.heading3"),
    placeholderParagraph: i18next.t("editor.typeForActions"),
    placeholderParagraphTouch: i18next.t("editor.typeSomething"),
    placeholderListItem: i18next.t("blocks.listItem"),
    placeholderTodoItem: i18next.t("blocks.todoItem"),
    placeholderMath: i18next.t("editor.math.placeholder"),
  };
}

/**
 * Per-node localized strings, keyed by block type then the node's local string
 * key (mirrors each node's `strings` catalog). Passed as `theme.nodeStrings`;
 * the editor overlays these onto the nodes' English defaults per instance.
 */
export function editorNodeStrings(): Record<string, Record<string, string>> {
  return {
    image: {
      clickToUpload: i18next.t("image.clickToUpload"),
      loading: i18next.t("image.loading"),
      uploading: i18next.t("image.uploading"),
      uploadFailed: i18next.t("error.failedToUploadImage"),
      changeImage: i18next.t("image.changeImage"),
    },
    quote: {
      placeholder: i18next.t(
        "blocks.quotePlaceholder",
        "Write something worth remembering…",
      ),
    },
  };
}

/**
 * The app's editor theme from the current `--editor-*` CSS variables, plus the
 * app font registry and per-node strings — the headless editor never reads the
 * DOM, so we feed it these. Pass `overrides` (e.g. `fontFamily`, or compact
 * `styles` for the title surface) to specialize; they are DEEP-merged over the
 * base via `mergeTheme`, so a `styles` override composes with the CSS-driven
 * styles (todo checkbox, image handles) instead of replacing them.
 */
export function appEditorTheme(overrides?: Partial<EditorTheme>): EditorTheme {
  const base: EditorTheme = {
    ...cssVarsToTheme(),
    fonts: getAppFontRegistry(),
    nodeStrings: editorNodeStrings(),
  };
  return overrides ? mergeTheme(base, overrides) : base;
}

/**
 * Keep a live editor's theme in sync with dark-mode toggles and font-registry
 * changes (Arabic stacks loading, etc.) — the same subscriptions the body editor
 * uses, so every surface restyles together. No-op until `editor` is non-null.
 */
export function useLiveEditorTheme<
  D extends SchemaDefinition = BaseSchemaDefinition,
>(editor: CypherEditor<D> | null): void {
  useEffect(() => {
    if (!editor) return;
    // Re-push the CSS-driven theme whenever the document root's class flips
    // (dark mode changes both color tokens and targeted style overrides).
    const themeObserver = new MutationObserver(() => {
      editor.setTheme(cssVarsToTheme());
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    const offFontRegistry = onAppFontRegistryChange(() => {
      editor.setTheme({ fonts: getAppFontRegistry() });
    });
    return () => {
      themeObserver.disconnect();
      offFontRegistry();
    };
  }, [editor]);
}

/**
 * Mount an editor on the app's shared core: it wraps `@cypherkit/react`'s
 * `useEditor` with this app's {@link appEditorTheme} and {@link editorStrings}
 * defaults, then wires {@link useLiveEditorTheme} so dark-mode and font-registry
 * changes restyle it. This is the ONE place the body {@link PageEditor} and the
 * {@link TitleEditor} share, so both render identically and gain editor features
 * together.
 *
 * Options are the full `useEditor` set — pass `doc`, `schema`, `window`,
 * `editable`, placeholders, padding, etc. as usual. Two fields are specialized:
 * - `strings` defaults to {@link editorStrings}; override to supply your own.
 * - `theme` is treated as *overrides* merged over {@link appEditorTheme}'s base
 *   (CSS tokens + fonts + node strings) — e.g. `{ fontFamily }` — rather than a
 *   full theme, so every surface keeps the same base look.
 */
export function useEditorCore<
  D extends SchemaDefinition = BaseSchemaDefinition,
>(options: UseEditorOptions<D>): UseEditorResult<D> {
  const result = useEditor<D>({
    ...options,
    strings: options.strings ?? editorStrings(),
    theme: appEditorTheme(options.theme),
  } as UseEditorOptions<D>);
  useLiveEditorTheme(result.editor);
  return result;
}

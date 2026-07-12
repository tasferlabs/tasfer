import {
  parsePage,
  tokenizePage,
} from "@cypherkit/editor";
import { findTitleBlock, inlineToHtml } from "@cypherkit/editor/internal";
import { renderToSVG } from "@cypherkit/editor/math";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/utils";
import { appDataSchema } from "../appDataSchema";
import style from "./TitlePreview.module.css";

/**
 * Rendered-HTML cache keyed by (math font size, title markdown). Rows unmount
 * and remount constantly (tree expand/collapse, virtualized lists), and
 * typesetting a math run is the one genuinely costly step — the cache makes a
 * remount free. Pure content-addressed memoization, so sharing it across every
 * preview on the page is safe.
 */
const htmlCache = new Map<string, string>();
const HTML_CACHE_MAX = 500;

function titleMarkdownToHtml(
  titleMd: string,
  mathFontSize: number,
): string | null {
  const key = `${mathFontSize} ${titleMd}`;
  const cached = htmlCache.get(key);
  if (cached !== undefined) return cached || null;

  let html = "";
  try {
    const block = findTitleBlock(
      parsePage(tokenizePage(titleMd, appDataSchema), appDataSchema).blocks,
    );
    if (block) {
      html = inlineToHtml(
        block.charRuns ?? [],
        block.formats ?? [],
        appDataSchema,
        (type, source, displayMode) => {
          if (type !== "math") {
            throw new Error(`Unsupported replacement: ${type}`);
          }
          return renderToSVG(source, displayMode, mathFontSize);
        },
      );
    }
  } catch {
    // Unparseable stored markdown — fall back to the plain title.
    html = "";
  }

  if (htmlCache.size >= HTML_CACHE_MAX) {
    htmlCache.delete(htmlCache.keys().next().value!);
  }
  htmlCache.set(key, html);
  return html || null;
}

export interface TitlePreviewProps {
  /** The plain title record string — the fallback when no markdown is stored. */
  title?: string | null;
  /**
   * The title's rich record string (`IListPage.titleMd`): the title line as
   * inline markdown, persisted alongside the plain title.
   */
  titleMd?: string | null;
  /**
   * Font size (px) math runs are typeset at. Match the surrounding text —
   * everything else inherits the row's own font/color/size.
   */
  mathFontSize?: number;
  className?: string;
}

/**
 * The read-only, render-cheap sibling of {@link TitleEditor}: shows a page
 * title WITH its inline marks (bold, italic, code, strike — and math as the
 * typeset formula, never raw LaTeX) anywhere a title appears outside its
 * document — sidebar rows, drag overlays, cards.
 *
 * It costs no editor instance and no doc load: the persisted `titleMd` record
 * string is parsed and rendered to plain DOM through the engine's mark codecs
 * ({@link inlineToHtml}), so a new mark type renders here for free. Rendered
 * HTML is memoized module-wide, making the per-row cost of a large sidebar
 * negligible. Falls back to the plain `title` (or the localized "Untitled")
 * when no markdown projection is stored.
 */
export function TitlePreview({
  title,
  titleMd,
  mathFontSize = 14,
  className,
}: TitlePreviewProps) {
  const { t } = useTranslation();
  const html = useMemo(
    () => (titleMd ? titleMarkdownToHtml(titleMd, mathFontSize) : null),
    [titleMd, mathFontSize],
  );

  if (html) {
    return (
      <span
        className={cn(style.preview, className)}
        // Safe by construction: inlineToHtml escapes all text; tags come only
        // from the engine's own mark codecs and math SVG renderer.
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }
  return (
    <span className={className}>
      {title || t("common.untitled", "Untitled")}
    </span>
  );
}

/**
 * HTML serializer — orchestrator only.
 *
 * Per-block-type markup lives in the block codecs (./codecs). This file owns
 * the cross-block concerns: <ul>/<ol> group wrapping (adjacent list items
 * share one parent element), edge trimming of empty blocks, and the document
 * shell. Hosts can inject feature replacement renderers; schema-optional legacy
 * calls retain the historical built-in math renderer.
 */

import { getCompatibilityDataSchema } from "../compatibilityDataSchema";
import { renderToSVG } from "../nodes/math";
import { iterateVisibleChars } from "../sync/char-runs";
import { hasStructuredBlockAuthority } from "../sync/structured-content";
import type { DataSchema } from "../sync/schema";
import type { OutputCtx, ReplacementRenderer } from "./codecs";
import { escapeHtml, inlineToHtml } from "./codecs/inline";
import type { Block } from "./loadPage";

const STYLES = `
  body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 720px; margin: 2em auto; padding: 0 1em; color: #111; line-height: 1.6; font-size: 11pt; }
  @page { margin: 0.3in; }
  h1 { font-size: 2em; margin: 0.67em 0; }
  h2 { font-size: 1.5em; margin: 0.83em 0; }
  h3 { font-size: 1.17em; margin: 1em 0; }
  p { margin: 0.6em 0; }
  blockquote { margin: 1em 0; padding: 0.8em 1em; border-left: 4px solid #10b981; border-radius: 8px; background: #f4f4f5; }
  hr { border: none; border-top: 1px solid #ccc; margin: 1.5em 0; }
  code { font-family: 'SF Mono', Menlo, Consolas, monospace; background: #f4f4f4; padding: 0.1em 0.3em; border-radius: 3px; font-size: 0.9em; }
  a { color: #2563eb; }
  ul, ol { margin: 0.6em 0; padding-left: 2em; }
  li { margin: 0.2em 0; }
  .todo { list-style: none; padding-left: 0; }
  .todo li { display: flex; align-items: flex-start; gap: 0.5em; }
  .todo input { margin-top: 0.3em; }
  svg { max-width: 100%; }
  @media print { html, body { margin: 0; padding: 0; max-width: none; } body > *:first-child { margin-top: 0; } a { color: inherit; text-decoration: none; } }
`;

function renderLegacyReplacement(
  type: string,
  source: string,
  displayMode: boolean,
): string {
  if (type !== "math") throw new Error(`No renderer for ${type}`);
  return renderToSVG(source, displayMode);
}

export interface HtmlSerializeOptions {
  title?: string;
  /** Asset url → replacement url (e.g. data URIs for self-contained export). */
  imageUrlMap?: Map<string, string>;
  /**
   * Extra CSS appended to the document `<style>` (e.g. `@font-face` rules that
   * inline the math fonts as data URLs, so rendered math survives being loaded
   * into an isolated print context that never loaded the app's fonts). Ignored
   * by {@link serializeToHTMLFragment} — only the full-document shell has a
   * `<style>` to carry it.
   */
  extraCss?: string;
  /** Block/mark types in play. Defaults to the built-in set. */
  schema?: DataSchema;
  /** Render feature-owned replacements such as math or diagrams. */
  renderReplacement?: ReplacementRenderer;
  /**
   * Emit editable source instead of rendered replacements (math → `$$…$$`
   * rather than an SVG). Set by the clipboard path so copied math pastes as
   * LaTeX into external apps; left off for file export (which wants the
   * rendered formula). See {@link OutputCtx.preferSource}.
   */
  preferSource?: boolean;
}

interface ListGroup {
  type: "bullet" | "numbered" | "todo";
  indent: number;
  html: string[];
}

function flushLists(stack: ListGroup[], target: number): string {
  let out = "";
  while (stack.length > target) {
    const g = stack.pop()!;
    const tag = g.type === "numbered" ? "ol" : "ul";
    const cls = g.type === "todo" ? ' class="todo"' : "";
    out += `<${tag}${cls}>${g.html.join("")}</${tag}>`;
    if (stack.length > 0) {
      // attach as nested inside the last item of parent
      const parent = stack[stack.length - 1];
      const last = parent.html.length - 1;
      if (last >= 0) {
        // insert before closing </li>
        parent.html[last] = parent.html[last].replace(/<\/li>$/, out + "</li>");
        out = "";
      }
    }
  }
  return out;
}

function isEmptyTextualBlock(b: Block, schema: DataSchema): boolean {
  if (!schema.isTextual(b.type) || !("charRuns" in b)) return false;
  // A block-authority structured document (a display equation) has empty flat
  // text but real content — never trim it.
  if (hasStructuredBlockAuthority(b)) return false;
  for (const _ of iterateVisibleChars(b.charRuns)) return false;
  return true;
}

/**
 * Serialize blocks to an HTML *fragment* (no document shell) — the per-block
 * markup plus the cross-block list grouping. Each block's markup comes from its
 * node codec (`codec.html.output`), never a per-type switch here, so a new block
 * type serializes for free. Used directly for the clipboard `text/html` payload
 * and wrapped in a document shell by {@link serializeToHTML} for file export.
 */
export function serializeToHTMLFragment(
  blocks: Block[],
  options: HtmlSerializeOptions = {},
): string {
  const schema = options.schema ?? getCompatibilityDataSchema();
  const renderReplacement =
    options.renderReplacement ?? renderLegacyReplacement;
  const live = blocks.filter((b) => !b.deleted);
  while (live.length > 0 && isEmptyTextualBlock(live[0], schema)) live.shift();
  while (live.length > 0 && isEmptyTextualBlock(live[live.length - 1], schema))
    live.pop();

  const ctx: OutputCtx = {
    format: "html",
    inline: (charRuns, formats) =>
      inlineToHtml(
        charRuns,
        formats,
        schema,
        renderReplacement,
        options.preferSource,
      ),
    mapAssetUrl: (url) => options.imageUrlMap?.get(url) ?? url,
    renderReplacement,
    preferSource: options.preferSource,
  };

  const parts: string[] = [];
  const listStack: ListGroup[] = [];

  const closeAllLists = () => {
    parts.push(flushLists(listStack, 0));
  };

  for (const block of live) {
    const codec = schema.getCodec(block.type);
    if (!codec) continue;
    const blockCtx: OutputCtx = {
      ...ctx,
      inline: (charRuns, formats) =>
        inlineToHtml(
          charRuns,
          formats,
          schema,
          renderReplacement,
          options.preferSource,
          block.structuredContent,
        ),
    };

    const kind = schema.listKind(block.type);
    if (kind) {
      const indent = "indent" in block ? block.indent || 0 : 0;

      // Pop deeper or differently-typed groups at same level
      while (
        listStack.length > 0 &&
        (listStack[listStack.length - 1].indent > indent ||
          (listStack[listStack.length - 1].indent === indent &&
            listStack[listStack.length - 1].type !== kind))
      ) {
        const popped = flushLists(listStack, listStack.length - 1);
        if (popped) parts.push(popped);
      }

      // Push new group if needed
      if (
        listStack.length === 0 ||
        listStack[listStack.length - 1].indent < indent ||
        listStack[listStack.length - 1].type !== kind
      ) {
        listStack.push({ type: kind, indent, html: [] });
      }

      // The codec emits the <li> element; the group owns the <ul>/<ol>.
      listStack[listStack.length - 1].html.push(
        codec.html.output(block, blockCtx),
      );
      continue;
    }

    closeAllLists();
    parts.push(codec.html.output(block, blockCtx));
  }

  closeAllLists();
  return parts.join("\n");
}

export function serializeToHTML(
  blocks: Block[],
  options: HtmlSerializeOptions = {},
): string {
  const body = serializeToHTMLFragment(blocks, options);
  const title = options.title ? escapeHtml(options.title) : "Document";
  const css = options.extraCss ? `${STYLES}\n${options.extraCss}` : STYLES;
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<title>${title}</title>
<style>${css}</style>
</head>
<body>
${body}
</body>
</html>`;
}

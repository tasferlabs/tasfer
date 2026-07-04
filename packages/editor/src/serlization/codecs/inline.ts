/**
 * Shared inline-content rendering for codecs.
 *
 * One segment-grouping pass (formerly duplicated between serializer.ts and
 * htmlSerializer.ts) plus a renderer per format. Orchestrators bind the right
 * renderer into `OutputCtx.inline`, so codec output functions are
 * format-agnostic about rich text.
 */

import { titleInlineMarkdownProjection } from "../../sync/block-registry";
import {
  findTitleBlock,
  getVisibleTextFromRuns,
  iterateVisibleChars,
} from "../../sync/char-runs";
import type { DataSchema } from "../../sync/schema";
import type { Block, CharRun, Mark, MarkSpan } from "../loadPage";
import type { MarkHtmlCtx } from "./mark-codec";

export interface Segment {
  text: string;
  formats?: Mark[];
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) {
    if (!b.has(item)) return false;
  }
  return true;
}

function formatKeysToFormats(keys: Set<string>): Mark[] | undefined {
  if (keys.size === 0) return undefined;
  const formats: Mark[] = [];
  for (const key of keys) {
    if (key.startsWith("link:")) {
      formats.push({ type: "link", attrs: { url: key.slice(5) } });
    } else {
      formats.push({ type: key });
    }
  }
  return formats.length > 0 ? formats : undefined;
}

/** Group visible chars into runs of identical formatting. */
export function groupSegments(
  charRuns: CharRun[],
  formats: MarkSpan[],
): Segment[] {
  const visibleChars: Array<{ id: string; char: string }> = [];
  for (const { id, char } of iterateVisibleChars(charRuns)) {
    visibleChars.push({ id, char });
  }

  if (visibleChars.length === 0) return [];

  // Build format map: charId -> Set<formatKey>
  const formatMap = new Map<string, Set<string>>();
  for (const span of formats) {
    const startIdx = visibleChars.findIndex((c) => c.id === span.startCharId);
    const endIdx = visibleChars.findIndex((c) => c.id === span.endCharId);
    if (startIdx === -1 || endIdx === -1) continue;

    for (let i = startIdx; i <= endIdx; i++) {
      const charId = visibleChars[i].id;
      if (!formatMap.has(charId)) {
        formatMap.set(charId, new Set());
      }
      const key =
        span.format.type +
        (span.format.attrs?.url ? `:${span.format.attrs.url}` : "");
      formatMap.get(charId)!.add(key);
    }
  }

  const segments: Segment[] = [];
  let currentChars: string[] = [];
  let currentFormatKeys = new Set<string>();

  for (const char of visibleChars) {
    const charFormats = formatMap.get(char.id) || new Set<string>();
    if (setsEqual(currentFormatKeys, charFormats)) {
      currentChars.push(char.char);
    } else {
      if (currentChars.length > 0) {
        segments.push({
          text: currentChars.join(""),
          formats: formatKeysToFormats(currentFormatKeys),
        });
      }
      currentChars = [char.char];
      currentFormatKeys = new Set(charFormats);
    }
  }

  if (currentChars.length > 0) {
    segments.push({
      text: currentChars.join(""),
      formats: formatKeysToFormats(currentFormatKeys),
    });
  }

  return segments;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function escapeAttr(s: string): string {
  return escapeHtml(s);
}

/**
 * Markdown inline rendering: `**bold**`, `*italic*`, `[text](url)`, … Each
 * mark's delimiters come from its {@link MarkCodec} on the schema, so the set
 * of marks is data-driven rather than a hardcoded `format.type === …` chain.
 * Marks with no markdown codec (custom marks) are emitted as their text.
 */
export function inlineToMarkdown(
  charRuns: CharRun[],
  formats: MarkSpan[],
  schema: DataSchema,
): string {
  const segments = groupSegments(charRuns, formats);
  let content = "";
  for (const segment of segments) {
    let text = segment.text;
    if (segment.formats) {
      for (const format of segment.formats) {
        const codec = schema.getMarkCodec(format.type);
        if (codec) text = codec.toMarkdown(text, format);
      }
    }
    content += text;
  }
  return content;
}

/**
 * HTML inline rendering: `<strong>`, `<em>`, `<a href>`, math via injected
 * renderer. Each mark's HTML comes from its {@link MarkCodec.html} on the
 * schema — a replacement mark (math) wins the run, otherwise the run's marks
 * wrap in ascending `priority` (innermost first), reproducing the prior fixed
 * nesting without a hardcoded per-mark chain.
 */
export function inlineToHtml(
  charRuns: CharRun[],
  formats: MarkSpan[],
  schema: DataSchema,
  renderMathSVG?: (latex: string, displayMode: boolean) => string,
  preferSource?: boolean,
): string {
  const segments = groupSegments(charRuns, formats);
  return segments
    .map((seg) => {
      const escaped = escapeHtml(seg.text);
      if (!seg.formats) return escaped;

      const ctx: MarkHtmlCtx = {
        text: seg.text,
        escapeHtml,
        escapeAttr,
        renderMathSVG,
        preferSource,
      };
      const entries = seg.formats
        .map((mark) => ({ html: schema.getMarkCodec(mark.type)?.html, mark }))
        .filter((e): e is { html: NonNullable<typeof e.html>; mark: Mark } =>
          Boolean(e.html),
        );

      // A replacement mark (inline math) renders the whole run.
      const replacement = entries.find((e) => e.html.replace);
      if (replacement)
        return replacement.html.render(escaped, replacement.mark, ctx);

      // Otherwise wrap innermost-first by priority.
      entries.sort((a, b) => a.html.priority - b.html.priority);
      let html = escaped;
      for (const { html: codec, mark } of entries) {
        html = codec.render(html, mark, ctx);
      }
      return html;
    })
    .join("");
}

/** Plain text rendering: visible characters, formatting dropped. */
export function inlineToText(charRuns: CharRun[]): string {
  return getVisibleTextFromRuns(charRuns);
}

const MAX_TITLE_MARKDOWN_VISIBLE_LENGTH = 100;

/**
 * The document title as inline MARKDOWN — the rich sibling of
 * `extractTitleFromBlocks` (which returns the same title block's visible text
 * with all marks stripped). Both read the block chosen by
 * {@link findTitleBlock}, so the plain and rich projections of a page's title
 * always describe the same content. Hosts persist this next to the plain title
 * to drive rich title previews (sidebar rows, cards) without loading the doc.
 *
 * `maxLength` caps the VISIBLE length like the plain extractor, with one
 * difference: a formatted run is emitted whole or not at all — slicing inside
 * a mark's delimiters can corrupt its source (half a math run's LaTeX). The
 * last run kept may therefore soft-overflow the cap, bounded at 2×.
 */
export function extractTitleMarkdownFromBlocks(
  blocks: Block[] | undefined,
  schema: DataSchema,
  maxLength: number = MAX_TITLE_MARKDOWN_VISIBLE_LENGTH,
): string {
  const block = findTitleBlock(blocks);
  if (!block) return "";

  // A block whose text needs projecting into an inline context (a math block's
  // LaTeX becomes an inline `$…$` run) is emitted whole or not at all, like a
  // formatted run: slicing inside projected source corrupts it.
  const project = titleInlineMarkdownProjection(block.type);
  if (project) {
    const text = getVisibleTextFromRuns(block.charRuns).trim();
    if (!text || text.length > maxLength * 2) return "";
    return project(text);
  }

  const segments = groupSegments(block.charRuns ?? [], block.formats ?? []);
  let out = "";
  let visible = 0;
  for (const segment of segments) {
    if (visible >= maxLength) break;

    if (!segment.formats) {
      const text = segment.text.slice(0, maxLength - visible);
      out += text;
      visible += text.length;
      continue;
    }

    if (visible + segment.text.length > maxLength * 2) break;
    let text = segment.text;
    for (const format of segment.formats) {
      const codec = schema.getMarkCodec(format.type);
      if (codec) text = codec.toMarkdown(text, format);
    }
    out += text;
    visible += segment.text.length;
  }

  return out.trim();
}

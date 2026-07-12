/**
 * Shared inline-content rendering for codecs.
 *
 * One segment-grouping pass (formerly duplicated between serializer.ts and
 * htmlSerializer.ts) plus a renderer per format. Orchestrators bind the right
 * renderer into `OutputCtx.inline`, so codec output functions are
 * format-agnostic about rich text.
 */

import { resolveMarkRunsFromChars } from "../../inline-math-spans";
import { titleInlineMarkdownProjection } from "../../sync/block-registry";
import {
  findTitleBlock,
  getVisibleTextFromRuns,
  iterateAllChars,
  iterateVisibleChars,
} from "../../sync/char-runs";
import type { DataSchema } from "../../sync/schema";
import type { StructuredContentMap } from "../../sync/structured-content";
import {
  type Block,
  type CharRun,
  type Mark,
  markKey,
  type MarkSpan,
} from "../loadPage";
import type { MarkHtmlCtx } from "./mark-codec";
import type { ReplacementRenderer } from "./types";

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

function formatKeysToFormats(
  keys: Set<string>,
  formatsByKey: ReadonlyMap<string, Mark>,
): Mark[] | undefined {
  if (keys.size === 0) return undefined;
  const formats: Mark[] = [];
  for (const key of keys) {
    const format = formatsByKey.get(key);
    if (format) formats.push(format);
  }
  return formats.length > 0 ? formats : undefined;
}

/** Group visible chars into runs of identical formatting. */
export function groupSegments(
  charRuns: CharRun[],
  formats: MarkSpan[],
): Segment[] {
  const visibleChars: string[] = [];
  for (const { char } of iterateVisibleChars(charRuns)) {
    visibleChars.push(char);
  }

  if (visibleChars.length === 0) return [];

  // Resolve each mark to its surviving visible-char range through the SAME
  // tombstone-tolerant resolver the render/caret path uses
  // ({@link resolveMarkRunsFromChars}, keyed off document-order ordinals over all
  // chars). The former strict `findIndex` over only visible chars dropped a whole
  // span the instant either endpoint char was tombstoned — so an inline-math chip
  // whose leading/trailing char had been deleted during editing lost its "math"
  // mark on the way out and serialized as raw `$…$` LaTeX (visible to the reader
  // in the exported PDF/Markdown), even though the canvas still painted it typeset.
  // Going through the same resolver keeps export and render in agreement.
  const runs = resolveMarkRunsFromChars(iterateAllChars(charRuns), formats);
  const formatKeys: Set<string>[] = visibleChars.map(() => new Set<string>());
  const formatsByKey = new Map<string, Mark>();
  for (const run of runs) {
    const format: Mark = {
      type: run.name,
      ...(Object.keys(run.attrs).length > 0 ? { attrs: run.attrs } : {}),
    };
    const key = markKey(format);
    formatsByKey.set(key, format);
    for (let i = run.startIndex; i < run.endIndex; i++) formatKeys[i].add(key);
  }

  const segments: Segment[] = [];
  let currentChars: string[] = [];
  let currentFormatKeys = new Set<string>();

  for (let i = 0; i < visibleChars.length; i++) {
    const charFormats = formatKeys[i];
    if (setsEqual(currentFormatKeys, charFormats)) {
      currentChars.push(visibleChars[i]);
    } else {
      if (currentChars.length > 0) {
        segments.push({
          text: currentChars.join(""),
          formats: formatKeysToFormats(currentFormatKeys, formatsByKey),
        });
      }
      currentChars = [visibleChars[i]];
      currentFormatKeys = new Set(charFormats);
    }
  }

  if (currentChars.length > 0) {
    segments.push({
      text: currentChars.join(""),
      formats: formatKeysToFormats(currentFormatKeys, formatsByKey),
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
  attachments?: StructuredContentMap,
): string {
  const segments = groupSegments(charRuns, formats);
  let content = "";
  for (const segment of segments) {
    let text = resolveStructuredSegmentText(segment, schema, attachments);
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
  renderReplacement?: ReplacementRenderer,
  preferSource?: boolean,
  attachments?: StructuredContentMap,
): string {
  const segments = groupSegments(charRuns, formats);
  return segments
    .map((seg) => {
      const text = resolveStructuredSegmentText(seg, schema, attachments);
      const escaped = escapeHtml(text);
      if (!seg.formats) return escaped;

      const ctx: MarkHtmlCtx = {
        text,
        escapeHtml,
        escapeAttr,
        renderReplacement,
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

/**
 * Plain text rendering: visible characters, formatting dropped — except marks
 * that declare a {@link MarkCodec.toText} projection (inline math keeps its
 * `$…$` delimiters so the LaTeX survives a plain-text paste). Data-driven
 * through the schema, so there is no per-mark-type chain here.
 */
export function inlineToText(
  charRuns: CharRun[],
  formats: MarkSpan[],
  schema: DataSchema,
  attachments?: StructuredContentMap,
): string {
  const segments = groupSegments(charRuns, formats);
  let content = "";
  for (const segment of segments) {
    let text = resolveStructuredSegmentText(segment, schema, attachments);
    if (segment.formats) {
      for (const format of segment.formats) {
        const toText = schema.getMarkCodec(format.type)?.toText;
        if (toText) text = toText(text, format);
      }
    }
    content += text;
  }
  return content;
}

function resolveStructuredSegmentText(
  segment: Segment,
  schema: DataSchema,
  attachments: StructuredContentMap | undefined,
): string {
  for (const mark of segment.formats ?? []) {
    const source = schema.features.resolveStructuredMark(mark.type, {
      mark,
      compatibilityText: segment.text,
      attachments,
    });
    if (source !== undefined) return source;
  }
  return segment.text;
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

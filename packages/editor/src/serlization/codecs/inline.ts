/**
 * Shared inline-content rendering for codecs.
 *
 * One segment-grouping pass (formerly duplicated between serializer.ts and
 * htmlSerializer.ts) plus a renderer per format. Orchestrators bind the right
 * renderer into `OutputCtx.inline`, so codec output functions are
 * format-agnostic about rich text.
 */

import {
  getVisibleTextFromRuns,
  iterateVisibleChars,
} from "../../sync/char-runs";
import type { CharRun, Mark, MarkSpan } from "../loadPage";

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
      formats.push({ type: "link", url: key.slice(5) });
    } else {
      formats.push({ type: key as Mark["type"] });
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
        span.format.type + (span.format.url ? `:${span.format.url}` : "");
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

/** Markdown inline rendering: `**bold**`, `*italic*`, `[text](url)`, … */
export function inlineToMarkdown(
  charRuns: CharRun[],
  formats: MarkSpan[],
): string {
  const segments = groupSegments(charRuns, formats);
  let content = "";
  for (const segment of segments) {
    let text = segment.text;
    if (segment.formats) {
      for (const format of segment.formats) {
        if (format.type === "strong") {
          text = `**${text}**`;
        } else if (format.type === "emphasis") {
          text = `*${text}*`;
        } else if (format.type === "strike") {
          text = `~~${text}~~`;
        } else if (format.type === "code") {
          text = `\`${text}\``;
        } else if (format.type === "math") {
          text = `$${text}$`;
        } else if (format.type === "link" && format.url) {
          text = `[${text}](${format.url})`;
        }
      }
    }
    content += text;
  }
  return content;
}

/** HTML inline rendering: `<strong>`, `<em>`, `<a href>`, math via injected renderer. */
export function inlineToHtml(
  charRuns: CharRun[],
  formats: MarkSpan[],
  renderMathSVG?: (latex: string, displayMode: boolean) => string,
): string {
  const segments = groupSegments(charRuns, formats);
  return segments
    .map((seg) => {
      let html = escapeHtml(seg.text);
      if (!seg.formats) return html;
      // Wrap in a deterministic order so nesting is consistent
      const has = (t: string) => seg.formats!.some((f) => f.type === t);
      const link = seg.formats.find((f) => f.type === "link");
      if (has("math")) {
        // Replace text content with rendered SVG; fall back to $...$ source
        try {
          if (!renderMathSVG) throw new Error("no math renderer");
          html = renderMathSVG(seg.text, false);
        } catch {
          html = `<code>$${escapeHtml(seg.text)}$</code>`;
        }
        return html;
      }
      if (has("code")) html = `<code>${html}</code>`;
      if (has("strong")) html = `<strong>${html}</strong>`;
      if (has("emphasis")) html = `<em>${html}</em>`;
      if (has("strike")) html = `<s>${html}</s>`;
      if (link && link.url)
        html = `<a href="${escapeAttr(link.url)}">${html}</a>`;
      return html;
    })
    .join("");
}

/** Plain text rendering: visible characters, formatting dropped. */
export function inlineToText(charRuns: CharRun[]): string {
  return getVisibleTextFromRuns(charRuns);
}

import { IMAGE_DEFAULT_HEIGHT } from "../constants";
import { renderToSVG } from "../mathjax";
import { iterateVisibleChars } from "../sync/char-runs";
import type { Block, CharRun, FormatSpan, TextFormat } from "./loadPage";
import { isImageDefault, isListBlock, isTextualBlock } from "./loadPage";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

interface Segment {
  text: string;
  formats?: TextFormat[];
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) if (!b.has(item)) return false;
  return true;
}

function formatKeysToFormats(keys: Set<string>): TextFormat[] | undefined {
  if (keys.size === 0) return undefined;
  const formats: TextFormat[] = [];
  for (const key of keys) {
    if (key.startsWith("link:"))
      formats.push({ type: "link", url: key.slice(5) });
    else formats.push({ type: key as TextFormat["type"] });
  }
  return formats.length > 0 ? formats : undefined;
}

function groupChars(charRuns: CharRun[], formats: FormatSpan[]): Segment[] {
  const visibleChars: Array<{ id: string; char: string }> = [];
  for (const { id, char } of iterateVisibleChars(charRuns)) {
    visibleChars.push({ id, char });
  }
  if (visibleChars.length === 0) return [];

  const formatMap = new Map<string, Set<string>>();
  for (const span of formats) {
    const startIdx = visibleChars.findIndex((c) => c.id === span.startCharId);
    const endIdx = visibleChars.findIndex((c) => c.id === span.endCharId);
    if (startIdx === -1 || endIdx === -1) continue;
    for (let i = startIdx; i <= endIdx; i++) {
      const charId = visibleChars[i].id;
      if (!formatMap.has(charId)) formatMap.set(charId, new Set());
      const key =
        span.format.type + (span.format.url ? `:${span.format.url}` : "");
      formatMap.get(charId)!.add(key);
    }
  }

  const segments: Segment[] = [];
  let currentChars: string[] = [];
  let currentFormatKeys = new Set<string>();
  for (const c of visibleChars) {
    const cf = formatMap.get(c.id) || new Set();
    if (setsEqual(currentFormatKeys, cf)) {
      currentChars.push(c.char);
    } else {
      if (currentChars.length > 0) {
        segments.push({
          text: currentChars.join(""),
          formats: formatKeysToFormats(currentFormatKeys),
        });
      }
      currentChars = [c.char];
      currentFormatKeys = new Set(cf);
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

function renderInline(charRuns: CharRun[], formats: FormatSpan[]): string {
  const segments = groupChars(charRuns, formats);
  return segments
    .map((seg) => {
      let html = escapeHtml(seg.text);
      if (!seg.formats) return html;
      // Wrap in a deterministic order so nesting is consistent
      const has = (t: string) => seg.formats!.some((f) => f.type === t);
      const link = seg.formats.find((f) => f.type === "link");
      if (has("math")) {
        // Replace text content with MathJax SVG; if rendering fails, fall back to $...$ source
        try {
          html = renderToSVG(seg.text, false);
        } catch {
          html = `<code>$${escapeHtml(seg.text)}$</code>`;
        }
        return html;
      }
      if (has("code")) html = `<code>${html}</code>`;
      if (has("bold")) html = `<strong>${html}</strong>`;
      if (has("italic")) html = `<em>${html}</em>`;
      if (has("strikethrough")) html = `<s>${html}</s>`;
      if (link && link.url)
        html = `<a href="${escapeAttr(link.url)}">${html}</a>`;
      return html;
    })
    .join("");
}

function renderImageBlock(
  block: Extract<Block, { type: "image" }>,
  urlOverride?: string,
): string {
  const src = urlOverride ?? block.url;
  const alt = block.alt ? escapeAttr(block.alt) : "";
  const styles: string[] = [
    "max-width:100%",
    "height:auto",
    "display:block",
    "margin:1em auto",
  ];

  if (!isImageDefault(block)) {
    if (typeof block.width === "number") styles.push(`width:${block.width}px`);
    if (block.height) styles.push(`height:${block.height}px`);
    const fit = block.objectFit ?? "cover";
    styles.push(`object-fit:${fit}`);
    if (!block.height) styles.push(`height:${IMAGE_DEFAULT_HEIGHT}px`);
  }

  return `<img src="${escapeAttr(src)}" alt="${alt}" style="${styles.join(";")}" />`;
}

function renderMathBlock(block: Extract<Block, { type: "math" }>): string {
  if (!block.latex) return "";
  try {
    const svg = renderToSVG(block.latex, block.displayMode);
    if (block.displayMode) {
      return `<div style="text-align:center;margin:1em 0;">${svg}</div>`;
    }
    return `<span style="display:inline-block;vertical-align:middle;">${svg}</span>`;
  } catch {
    return `<code>${escapeHtml(block.latex)}</code>`;
  }
}

const STYLES = `
  body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 720px; margin: 2em auto; padding: 0 1em; color: #111; line-height: 1.6; font-size: 11pt; }
  h1 { font-size: 2em; margin: 0.67em 0; }
  h2 { font-size: 1.5em; margin: 0.83em 0; }
  h3 { font-size: 1.17em; margin: 1em 0; }
  p { margin: 0.6em 0; }
  hr { border: none; border-top: 1px solid #ccc; margin: 1.5em 0; }
  code { font-family: 'SF Mono', Menlo, Consolas, monospace; background: #f4f4f4; padding: 0.1em 0.3em; border-radius: 3px; font-size: 0.9em; }
  a { color: #2563eb; }
  ul, ol { margin: 0.6em 0; padding-left: 2em; }
  li { margin: 0.2em 0; }
  .todo { list-style: none; padding-left: 0; }
  .todo li { display: flex; align-items: flex-start; gap: 0.5em; }
  .todo input { margin-top: 0.3em; }
  svg { max-width: 100%; }
  @media print { body { margin: 0; padding: 0; max-width: none; } a { color: inherit; text-decoration: none; } }
`;

interface RenderOptions {
  title?: string;
  imageUrlMap?: Map<string, string>;
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

export function serializeToHTML(
  blocks: Block[],
  options: RenderOptions = {},
): string {
  const live = blocks.filter((b) => !b.deleted);
  const parts: string[] = [];
  const listStack: ListGroup[] = [];

  const closeAllLists = () => {
    parts.push(flushLists(listStack, 0));
  };

  for (const block of live) {
    if (isListBlock(block)) {
      const kind: ListGroup["type"] =
        block.type === "numbered_list"
          ? "numbered"
          : block.type === "todo_list"
            ? "todo"
            : "bullet";
      const indent = block.indent || 0;

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

      const inner = renderInline(block.charRuns, block.formats);
      const group = listStack[listStack.length - 1];
      if (block.type === "todo_list") {
        const checked = block.checked ? " checked" : "";
        group.html.push(
          `<li><input type="checkbox" disabled${checked} /><span>${inner}</span></li>`,
        );
      } else {
        group.html.push(`<li>${inner}</li>`);
      }
      continue;
    }

    closeAllLists();

    if (block.type === "line") {
      parts.push("<hr />");
    } else if (block.type === "image") {
      const override = options.imageUrlMap?.get(block.url);
      parts.push(renderImageBlock(block, override));
    } else if (block.type === "math") {
      parts.push(renderMathBlock(block));
    } else if (isTextualBlock(block)) {
      const inner = renderInline(block.charRuns, block.formats) || "&nbsp;";
      if (block.type === "heading1") parts.push(`<h1>${inner}</h1>`);
      else if (block.type === "heading2") parts.push(`<h2>${inner}</h2>`);
      else if (block.type === "heading3") parts.push(`<h3>${inner}</h3>`);
      else parts.push(`<p>${inner}</p>`);
    }
  }

  closeAllLists();

  const title = options.title ? escapeHtml(options.title) : "Document";
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<title>${title}</title>
<style>${STYLES}</style>
</head>
<body>
${parts.join("\n")}
</body>
</html>`;
}

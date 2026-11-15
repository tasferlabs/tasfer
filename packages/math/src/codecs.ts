/**
 * Codecs, Markdown syntax rules and the snapshot clone adapter that
 * {@link mathDataExtension} installs. They are internal: hosts get all of them
 * by adding `mathDataExtension()` (or `mathExtension()`) to a schema.
 *
 * Kept out of `data.ts` so the `@tasfer/math/data` entry lists only public
 * names. Worker-safe like the data entry: no canvas, no `@tasfer/tex` layout.
 */

import { normalizeMathSource } from "./source";
import {
  getStructuredMathSource,
  mathContentIdForBlock,
  parseMathDocumentInit,
  structuredToMathDocument,
  validateStructuredMathDocument,
} from "./structured";
import type {
  StructuredContentCloneCtx,
  StructuredContentCloneResult,
  SyntaxRule,
} from "@tasfer/editor/feature-facets";
import { escapeHtml } from "@tasfer/editor/serlization/codecs/inline";
import type { MarkCodec } from "@tasfer/editor/serlization/codecs/mark-codec";
import type {
  BlockCodec,
  NodeCodec,
} from "@tasfer/editor/serlization/codecs/types";
import type { Block, CharRun } from "@tasfer/editor/serlization/loadPage";
import {
  INLINE_MATH_END,
  INLINE_MATH_START,
  MATH_BLOCK,
  NEWLINE,
  type VisibleToken,
} from "@tasfer/editor/serlization/tokenizer";
import { cloneStructuredDocumentWithFreshIdentities } from "@tasfer/editor/sync/structured-content";
import { printMathDocument as printMathDocumentValue } from "@tasfer/tex/data";

type MathTextBlock = Pick<Block, "id" | "structuredContent"> & {
  readonly charRuns: CharRun[];
};

/**
 * How a math block is read from Markdown and written as Markdown (`$$…$$`),
 * HTML and plain text. An empty block writes nothing. Used by both the
 * data-only math block and {@link MathNode}.
 */
export const mathBlockNodeCodec: NodeCodec = {
  markdown: {
    tokens: [MATH_BLOCK],
    output: (block) => {
      const latex = visibleSource(block as MathTextBlock);
      return latex ? `$$\n${latex}\n$$` : "";
    },
    input: (ctx) => {
      ctx.match(MATH_BLOCK);
      const latex = (ctx.previous() as VisibleToken).content;
      ctx.match(NEWLINE);
      // A display block's content lives only in its authority document; the
      // block's flat text stays empty. The deterministic default allocator is
      // parse-scoped — the import path re-addresses identities when the block
      // becomes CRDT ops.
      const id = ctx.nextBlockId();
      const contentId = mathContentIdForBlock(id);
      const init = parseMathDocumentInit(normalizeMathSource(latex), {
        contentId,
      });
      return {
        id,
        type: "math",
        charRuns: [],
        formats: [],
        structuredContent: { [contentId]: init.document },
        displayMode: true,
      } as unknown as Block;
    },
  },
  html: {
    output: (block, ctx) => {
      const latex = visibleSource(block as MathTextBlock);
      if (!latex) return "";
      if (ctx.preferSource) {
        return `<div style="text-align:center;margin:1em 0;">$$${escapeHtml(latex)}$$</div>`;
      }
      try {
        if (!ctx.renderReplacement) throw new Error("no math renderer");
        const rendered = ctx.renderReplacement("math", latex, true);
        return `<div style="text-align:center;margin:1em 0;">${rendered}</div>`;
      } catch {
        return `<code>${escapeHtml(latex)}</code>`;
      }
    },
  },
  text: {
    output: (block) => {
      const latex = visibleSource(block as MathTextBlock);
      return latex ? `$$${latex}$$` : "";
    },
  },
};

/**
 * {@link mathBlockNodeCodec} plus the block type it handles, ready for a data
 * schema. {@link mathDataExtension} already uses it.
 */
export const mathBlockCodec: BlockCodec = {
  types: ["math"],
  ...mathBlockNodeCodec,
};

/**
 * How inline math is read from Markdown and written as Markdown (`$…$`), plain
 * text and HTML. An empty formula writes nothing. Used by both the data-only
 * math mark and {@link MathMark}.
 */
export const mathMarkCodec: MarkCodec = {
  type: "math",
  // An empty formula (a box left without content) writes nothing: `$$` would
  // reload as two literal dollar signs, not as the box.
  toMarkdown: (text) => (text ? `$${text}$` : ""),
  toText: (text) => (text ? `$${text}$` : ""),
  tokens: { start: INLINE_MATH_START, end: INLINE_MATH_END },
  html: {
    priority: 0,
    replace: true,
    render: (_inner, _mark, ctx) => {
      const latex = ctx.text;
      if (!latex) return "";
      if (ctx.preferSource) return `$${ctx.escapeHtml(latex)}$`;
      try {
        if (!ctx.renderReplacement) throw new Error("no math renderer");
        return ctx.renderReplacement("math", latex, false);
      } catch {
        return `<code>$${ctx.escapeHtml(latex)}$</code>`;
      }
    },
  },
};

/**
 * Finds `$$…$$` block equations when Markdown is read.
 * {@link mathDataExtension} puts it on the math block.
 */
export const mathDisplaySyntaxRule = {
  id: "math.display-dollar-fence",
  scope: "block",
  priority: 100,
  match: ({ source, offset }) => {
    if (!source.startsWith("$$", offset)) return undefined;

    let cursor = offset + 2;
    if (source[cursor] === "\n") cursor += 1;
    else if (source[cursor] === "\r" && source[cursor + 1] === "\n") {
      cursor += 2;
    }
    const contentStart = cursor;
    const close = source.indexOf("$$", cursor);
    if (close < 0) return undefined;

    let latex = source.slice(contentStart, close);
    if (latex.endsWith("\n")) latex = latex.slice(0, -1);
    if (latex.endsWith("\r")) latex = latex.slice(0, -1);

    const fenceEnd = close + 2;
    let end = fenceEnd;
    const tokens: Array<{
      type: string;
      content?: string;
      raw?: string;
    }> = [
      {
        type: MATH_BLOCK,
        content: latex,
        raw: source.slice(offset, fenceEnd),
      },
    ];
    if (source[end] === "\n") {
      end += 1;
      tokens.push({ type: NEWLINE });
    } else if (source[end] === "\r" && source[end + 1] === "\n") {
      end += 2;
      tokens.push({ type: NEWLINE });
    }
    return { length: end - offset, tokens };
  },
} as const satisfies SyntaxRule;

/**
 * Finds `$…$` inline math when Markdown is read. The formula must sit on one
 * line and must not be empty. {@link mathDataExtension} puts it on the math
 * mark.
 */
export const mathInlineSyntaxRule = {
  id: "math.inline-dollar-delimiter",
  scope: "inline",
  priority: 50,
  match: ({ source, offset }) => {
    if (source[offset] !== "$") return undefined;
    let close = offset + 1;
    while (
      close < source.length &&
      source[close] !== "\n" &&
      source[close] !== "\r" &&
      source[close] !== "$"
    ) {
      close += 1;
    }
    if (source[close] !== "$" || close === offset + 1) return undefined;
    return {
      length: close - offset + 1,
      tokens: [
        { type: INLINE_MATH_START, content: "$", raw: "$" },
        { type: "text", content: source.slice(offset + 1, close) },
        { type: INLINE_MATH_END, content: "$", raw: "$" },
      ],
    };
  },
} as const satisfies SyntaxRule;

/** Canonical LaTeX of one structured math document (kind `source` adapter). */
export function mathStructuredContentSource(
  document: Parameters<typeof validateStructuredMathDocument>[0],
): string | undefined {
  const math = structuredToMathDocument(document);
  return math ? printMathDocumentValue(math) : undefined;
}

/**
 * Copies a formula's math document with fresh ids, for example when a snapshot
 * is restored under new block ids. A block equation's copy follows the new
 * block id, and an inline formula's copy gets a new id. Returns undefined when
 * the copy is not a valid math document.
 */
export function cloneMathStructuredContent({
  document,
  targetBlockId,
  identities,
}: StructuredContentCloneCtx): StructuredContentCloneResult | undefined {
  const contentId =
    document.authority === "block"
      ? mathContentIdForBlock(targetBlockId)
      : identities.nextId();
  const cloned = validateStructuredMathDocument(
    cloneStructuredDocumentWithFreshIdentities(document, contentId, identities),
  );
  return cloned ? { contentId, document: cloned } : undefined;
}

function visibleSource(block: MathTextBlock): string {
  return getStructuredMathSource(block) ?? "";
}

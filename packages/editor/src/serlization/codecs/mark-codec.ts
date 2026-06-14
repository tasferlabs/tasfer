/**
 * MarkCodec — the (canvas-free) serialization facet of an inline mark, the
 * inline analogue of {@link BlockCodec}.
 *
 * It bundles a mark's markdown round-trip: how it wraps inline text on output
 * (`toMarkdown`) and which paired tokenizer tokens open/close it on input
 * (`tokens`). This replaces the hardcoded `format.type === "strong" | …`
 * if/else chains in the markdown serializer and parser with per-type dispatch
 * through the schema.
 *
 * Scope note: the HTML round-trip and the clipboard paste path are not driven
 * through this codec yet (they're being reworked alongside contenteditable
 * support); only marks the tokenizer recognizes as paired delimiters declare
 * `tokens`. `link` is parsed specially (its url arrives after its text), so it
 * has a `toMarkdown` but no `tokens`.
 */

import type { Mark } from "../loadPage";
import {
  BOLD_END,
  BOLD_START,
  CODE_END,
  CODE_START,
  INLINE_MATH_END,
  INLINE_MATH_START,
  ITALIC_END,
  ITALIC_START,
  STRIKETHROUGH_END,
  STRIKETHROUGH_START,
  type TokenType,
} from "../tokenizer";

/** Helpers passed to an HTML codec so it needn't import the serializer. */
export interface MarkHtmlCtx {
  /** The run's raw (unescaped) text — needed by replacement marks (math). */
  readonly text: string;
  readonly escapeHtml: (s: string) => string;
  readonly escapeAttr: (s: string) => string;
  /** Inline math renderer, when the host supplied one. */
  readonly renderMathSVG?: (latex: string, displayMode: boolean) => string;
}

export interface MarkHtmlCodec {
  /**
   * Application order when several marks wrap one run — lower wraps innermost,
   * matching the prior fixed nesting (code → strong → emphasis → strike → link).
   */
  readonly priority: number;
  /**
   * If true, this mark REPLACES the run's content (inline math renders an SVG)
   * rather than wrapping `inner`; a replacement mark wins the run.
   */
  readonly replace?: boolean;
  /** Produce the HTML for the run; `inner` is the already-escaped child HTML. */
  render(inner: string, mark: Mark, ctx: MarkHtmlCtx): string;
}

export interface MarkCodec {
  readonly type: string;
  /** Wrap inline `text` in this mark's markdown delimiters. */
  toMarkdown(text: string, mark: Mark): string;
  /**
   * The tokenizer start/end tokens that open/close this mark. Set for marks the
   * tokenizer recognizes as paired inline delimiters (bold/italic/strike/code/
   * inline-math). Omitted for marks parsed specially (link) and for custom
   * marks (which round-trip via HTML tags, not new markdown delimiters).
   */
  readonly tokens?: { readonly start: TokenType; readonly end: TokenType };
  /** Inline-HTML output facet. Omitted marks contribute no HTML wrapping. */
  readonly html?: MarkHtmlCodec;
}

/** The built-in inline marks' markdown codecs, keyed by mark type. */
export const BUILTIN_MARK_CODECS: Readonly<Record<string, MarkCodec>> = {
  // `html.priority` reproduces the prior fixed nesting order exactly:
  // code (innermost) → strong → emphasis → strike → link (outermost). Math is a
  // replacement (renders an SVG, falls back to `$…$` source).
  strong: {
    type: "strong",
    toMarkdown: (t) => `**${t}**`,
    tokens: { start: BOLD_START, end: BOLD_END },
    html: { priority: 1, render: (inner) => `<strong>${inner}</strong>` },
  },
  emphasis: {
    type: "emphasis",
    toMarkdown: (t) => `*${t}*`,
    tokens: { start: ITALIC_START, end: ITALIC_END },
    html: { priority: 2, render: (inner) => `<em>${inner}</em>` },
  },
  strike: {
    type: "strike",
    toMarkdown: (t) => `~~${t}~~`,
    tokens: { start: STRIKETHROUGH_START, end: STRIKETHROUGH_END },
    html: { priority: 3, render: (inner) => `<s>${inner}</s>` },
  },
  code: {
    type: "code",
    toMarkdown: (t) => `\`${t}\``,
    tokens: { start: CODE_START, end: CODE_END },
    html: { priority: 0, render: (inner) => `<code>${inner}</code>` },
  },
  math: {
    type: "math",
    toMarkdown: (t) => `$${t}$`,
    tokens: { start: INLINE_MATH_START, end: INLINE_MATH_END },
    html: {
      priority: 0,
      replace: true,
      render: (_inner, _mark, ctx) => {
        try {
          if (!ctx.renderMathSVG) throw new Error("no math renderer");
          return ctx.renderMathSVG(ctx.text, false);
        } catch {
          return `<code>$${ctx.escapeHtml(ctx.text)}$</code>`;
        }
      },
    },
  },
  link: {
    type: "link",
    toMarkdown: (t, mark) =>
      mark.attrs?.url ? `[${t}](${mark.attrs.url})` : t,
    html: {
      priority: 4,
      render: (inner, mark, ctx) =>
        mark.attrs?.url
          ? `<a href="${ctx.escapeAttr(String(mark.attrs.url))}">${inner}</a>`
          : inner,
    },
  },
};

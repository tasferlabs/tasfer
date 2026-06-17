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
import { type TokenType } from "../tokenizer";

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

// The built-in marks' codecs are NOT enumerated here — each built-in Mark
// subclass (rendering/marks/*) owns its own `codec`, the inline analogue of a
// Node owning its serialization. `baseDataSchema` derives the schema's mark
// codecs from the registered marks, so there is no central mark table to keep
// in sync.

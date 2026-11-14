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
import type { ReplacementRenderer } from "./types";

/** Helpers passed to an HTML codec so it needn't import the serializer. */
export interface MarkHtmlCtx {
  /** The run's raw (unescaped) text — needed by replacement marks (math). */
  readonly text: string;
  readonly escapeHtml: (s: string) => string;
  readonly escapeAttr: (s: string) => string;
  /** Feature replacement renderer, when the host supplied one. */
  readonly renderReplacement?: ReplacementRenderer;
  /**
   * When `true`, write editable source instead of a rendered picture. Inline
   * math then writes its `$…$` source instead of an SVG. The editor sets it
   * when copying HTML to the clipboard, so pasted math stays editable.
   */
  readonly preferSource?: boolean;
}

/**
 * The HTML part of a {@link MarkCodec}: how a marked run of text becomes HTML,
 * and where it nests when several marks cover the same text.
 */
export interface MarkHtmlCodec {
  /**
   * Nesting order when several marks cover the same text. Lower numbers sit
   * further inside. The built-in values are code 0, strong 1, emphasis 2,
   * strike 3 and link 4.
   */
  readonly priority: number;
  /**
   * When `true`, `render` replaces the run's content instead of wrapping
   * `inner`. Inline math uses this to write an SVG. Other marks on the same run
   * are then not written.
   */
  readonly replace?: boolean;
  /** Produce the HTML for the run; `inner` is the already-escaped child HTML. */
  render(inner: string, mark: Mark, ctx: MarkHtmlCtx): string;
}

/**
 * How one inline mark is written to and read from Markdown, and optionally how
 * it appears in plain text and HTML. A custom mark supplies one so its
 * formatting is kept when the document is saved as Markdown and loaded again.
 */
export interface MarkCodec {
  readonly type: string;
  /** Wrap inline `text` in this mark's markdown delimiters. */
  toMarkdown(text: string, mark: Mark): string;
  /**
   * How a marked run reads as plain text, for example on a plain-text copy.
   * Leave it out to write the bare text. Inline math sets it to keep its `$…$`
   * delimiters, so the equation survives a plain-text paste.
   */
  toText?(text: string, mark: Mark): string;
  /**
   * The tokens that open and close this mark when Markdown is read, such as the
   * `**` pairs of bold. Built-in bold, italic, strike, code and inline math set
   * them. A custom mark needs them, plus its own `markdownSyntax`, to be read
   * back from Markdown. Link leaves them out because it is read in its own way.
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

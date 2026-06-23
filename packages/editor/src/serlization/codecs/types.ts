/**
 * Block codecs — per-block-type serialization, keyed by output format.
 *
 * A codec is the *serialization* facet of a block type, parallel to the
 * rendering Node (presentation) and the block-registry descriptor (CRDT
 * shape/validation). Each block type now carries its serialization AS METHODS
 * ON ITS NODE (`outputMarkdown` / `inputMarkdown` / `inputMarkdownTag` /
 * `outputHTML` / `outputText`, plus the `markdownTokens` / `htmlTags` /
 * `assetRefs` facets), so a block's rendering and round-trip live in one file
 * (src/nodes/*). `codecFromNode` (./from-node) adapts a node into the
 * `BlockCodec` shape below; `baseDataSchema` (../../baseDataSchema) assembles
 * the default schema from the node instances.
 *
 * The `BlockCodec` contract:
 *
 *   markdown.output / html.output / text.output — block → string
 *   markdown.tokens   — block-start tokens that dispatch to markdown.input
 *   markdown.htmlTags — HTML tag names (inside markdown) → markdown.inputTag
 *   assetRefs         — asset references (content hashes / urls) the block owns
 *
 * Cross-block concerns stay in the orchestrators (serializer/htmlSerializer/
 * textSerializer/parser): numbered-list numbering, HTML <ul>/<ol> grouping,
 * frontmatter, and the trailing-newline rule. Codecs receive what they need
 * through `OutputCtx` / `InputCtx`.
 *
 * This `types` module stays dependency-light (types + tokenizer only). The
 * parser/serializers dispatch through the per-instance `DataSchema` the editor
 * holds — not a static codec registry — so there is no parser→registry cycle;
 * and math rendering reaches the codec via `OutputCtx.renderMathSVG`, never a
 * direct MathJax import.
 */

import type { Block, CharRun, MarkSpan } from "../loadPage";
import type { Token, TokenType } from "../tokenizer";

export type SerialFormat = "markdown" | "html" | "text";

/** Context handed to every `output()` call. Built by the per-format orchestrator. */
export interface OutputCtx {
  readonly format: SerialFormat;
  /** Render rich text content (char runs + format spans) in the active format. */
  inline(charRuns: CharRun[], formats: MarkSpan[]): string;
  /**
   * Map an asset reference (content-hash url etc.) to the url to emit.
   * Identity by default; export flows supply bundle paths or data URIs.
   */
  mapAssetUrl(url: string): string;
  /** 1-based item number, set by the markdown orchestrator for numbered list items. */
  readonly listNumber?: number;
  /**
   * Host-supplied LaTeX → SVG renderer (HTML output only). Injected by the
   * HTML orchestrator so codec modules never import the MathJax bundle.
   */
  readonly renderMathSVG?: (latex: string, displayMode: boolean) => string;
  /**
   * When true, a node/mark that normally emits a *rendered replacement* in HTML
   * (math → an SVG image) should instead emit its editable SOURCE. Set on the
   * clipboard `text/html` payload so copied math lands as LaTeX (`$$…$$`) in
   * external apps that prefer HTML over plain text, rather than a non-editable
   * image. Left false for file/PDF export, where the rendered formula is wanted.
   * Plain nodes ignore it.
   */
  readonly preferSource?: boolean;
}

/** An HTML tag encountered in markdown input, pre-parsed by the orchestrator. */
export interface ParsedTag {
  readonly name: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly raw: string;
}

/**
 * Token-cursor view of the parser handed to `markdown.input()`. Same
 * semantics as the parser's internal helpers; the block-start token has NOT
 * been consumed (codecs consume their own trigger), except for `inputTag`
 * where the orchestrator consumes the HTML_TAG token to read the tag name.
 */
export interface InputCtx {
  /** Indent level (already consumed by the orchestrator) for this block. */
  readonly indent: number;
  /** Fresh unique block id. */
  nextBlockId(): string;
  /**
   * Parse inline tokens up to the end of line into CRDT runs + format spans.
   * Consumes the trailing newline.
   */
  inlineText(): { charRuns: CharRun[]; formats: MarkSpan[] };
  /**
   * Build CRDT runs from a literal string — no inline-mark parsing, newlines
   * kept verbatim. For blocks whose text is raw source (e.g. code). The caller
   * still consumes the block's tokens (trigger + trailing newline) itself.
   */
  rawText(text: string): CharRun[];
  match(...types: TokenType[]): boolean;
  check(type: TokenType): boolean;
  advance(): Token;
  previous(): Token;
  peek(): Token;
  isEnd(): boolean;
}

export interface MarkdownCodec {
  output(block: Block, ctx: OutputCtx): string;
  /** Block-start tokens that dispatch markdown parsing to `input`. */
  readonly tokens?: readonly TokenType[];
  input?(ctx: InputCtx): Block;
  /** HTML tag names (inside markdown) that dispatch to `inputTag`. */
  readonly htmlTags?: readonly string[];
  inputTag?(tag: ParsedTag, ctx: InputCtx): Block;
}

export interface HtmlCodec {
  output(block: Block, ctx: OutputCtx): string;
}

export interface TextCodec {
  output(block: Block, ctx: OutputCtx): string;
}

export interface BlockCodec {
  /** Every block type this codec handles (family codecs list several). */
  readonly types: readonly string[];
  readonly markdown: MarkdownCodec;
  readonly html: HtmlCodec;
  readonly text: TextCodec;
  /** Asset references (content hashes / urls) this block owns. */
  assetRefs?(block: Block): string[];
}

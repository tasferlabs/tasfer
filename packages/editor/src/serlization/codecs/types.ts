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
 * and feature-owned replacement rendering reaches codecs through
 * `OutputCtx.renderReplacement`, never a feature import in the core serializer.
 */

import type { StructuredContentMap } from "../../sync/structured-content";
import type { Block, CharRun, MarkRange, MarkSpan } from "../loadPage";
import type { Token, TokenType } from "../tokenizer";

/**
 * The formats a document can be written out as: Markdown, HTML or plain text.
 * A codec reads it from its output context to know which one is being produced.
 */
export type SerialFormat = "markdown" | "html" | "text";

/**
 * A function your app supplies to turn rich content, such as math, into HTML.
 * Pass it as `renderReplacement` to {@link serializeToHTML}. It gets the
 * content `type`, its `source` text, and `displayMode` (`true` when it stands
 * as its own block). It returns an HTML string.
 */
export type ReplacementRenderer = (
  type: string,
  source: string,
  displayMode: boolean,
) => string;

/** Context handed to every `output()` call. Built by the per-format orchestrator. */
export interface OutputCtx {
  readonly format: SerialFormat;
  /** Render rich text content (char runs + format spans) in the active format. */
  inline(charRuns: CharRun[], formats: readonly MarkRange[]): string;
  /**
   * Map an asset reference (content-hash url etc.) to the url to emit.
   * Identity by default; export flows supply bundle paths or data URIs.
   */
  mapAssetUrl(url: string): string;
  /** 1-based item number, set by the markdown orchestrator for numbered list items. */
  readonly listNumber?: number;
  /** Host-supplied renderer for feature-owned HTML replacements. */
  readonly renderReplacement?: ReplacementRenderer;
  /**
   * When `true`, a codec that normally writes a picture in HTML (math as an
   * SVG) should write its editable source instead (`$$…$$`). Copy sets it, so
   * math pastes into other apps as LaTeX. The screen-reader text sets it too.
   * File and PDF export leave it off. Plain nodes ignore it.
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
 * What the Markdown parser hands to a codec's `markdown.input()` and
 * `markdown.inputTag()`. It steps through the Markdown tokens one at a time. In
 * `input()`, the token that starts the block has not been read yet, so the
 * codec reads it itself. In `inputTag()`, the parser has already read the tag
 * token.
 */
export interface InputCtx {
  /** Indent level (already consumed by the orchestrator) for this block. */
  readonly indent: number;
  /** Fresh unique block id. */
  nextBlockId(): string;
  /**
   * Reads the rest of the line as rich text: its characters and their marks. It
   * also reads the newline at the end. Nested content, such as inline math,
   * comes back in `structuredContent`. Copy it onto the block, or that content
   * is lost.
   */
  inlineText(): {
    charRuns: CharRun[];
    formats: MarkSpan[];
    structuredContent?: StructuredContentMap;
  };
  /**
   * Turns a string into the block's characters as is: no marks are read and
   * newlines are kept. Use it for text that is source, such as code. It reads
   * no tokens, so the codec still reads the block's own tokens and the closing
   * newline.
   */
  rawText(text: string): CharRun[];
  /**
   * Parses a string of inline Markdown that is not part of the token stream,
   * such as one table cell's text. It uses the same schema and ids as the rest
   * of the parse, so nothing collides. Nested content, such as inline math,
   * comes back in `structuredContent`, as with {@link InputCtx.inlineText}.
   * Copy it onto the block. Returns `undefined` when the string is a block, not
   * one line of inline text, so you can keep it as plain text.
   */
  inlineMarkdown(source: string):
    | {
        charRuns: CharRun[];
        formats: MarkSpan[];
        structuredContent?: StructuredContentMap;
      }
    | undefined;
  match(...types: TokenType[]): boolean;
  check(type: TokenType): boolean;
  advance(): Token;
  previous(): Token;
  peek(): Token;
  isEnd(): boolean;
}

/**
 * The Markdown half of a {@link BlockCodec}. `output` writes a block as
 * Markdown; the optional `input` and `inputTag` read it back, from Markdown
 * tokens or from an HTML tag found inside Markdown.
 */
export interface MarkdownCodec {
  output(block: Block, ctx: OutputCtx): string;
  /** Block-start tokens that dispatch markdown parsing to `input`. */
  readonly tokens?: readonly TokenType[];
  input?(ctx: InputCtx): Block;
  /** HTML tag names (inside markdown) that dispatch to `inputTag`. */
  readonly htmlTags?: readonly string[];
  inputTag?(tag: ParsedTag, ctx: InputCtx): Block;
}

/**
 * The HTML half of a {@link BlockCodec}: turns one block into an HTML string.
 */
export interface HtmlCodec {
  output(block: Block, ctx: OutputCtx): string;
}

/**
 * The plain-text half of a {@link BlockCodec}: turns one block into plain text.
 */
export interface TextCodec {
  output(block: Block, ctx: OutputCtx): string;
}

/**
 * How blocks of one type (or a family of related types) are written as
 * Markdown, HTML and plain text, and read back from Markdown. A custom node
 * declares the same thing without `types` (a {@link NodeCodec}); the schema
 * fills in the type names.
 */
export interface BlockCodec {
  /** Every block type this codec handles (family codecs list several). */
  readonly types: readonly string[];
  readonly markdown: MarkdownCodec;
  readonly html: HtmlCodec;
  readonly text: TextCodec;
  /** Asset references (content hashes / urls) this block owns. */
  assetRefs?(block: Block): string[];
}

/**
 * How a node's blocks are written as Markdown, HTML and plain text, and read
 * back: a {@link BlockCodec} without `types`. Set it as the node's `codec`
 * property. The node already has its `type`, so the schema fills in `types`
 * (see {@link codecFromNode}).
 */
export type NodeCodec = Omit<BlockCodec, "types">;

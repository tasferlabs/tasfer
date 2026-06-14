/**
 * Adapt a node's serialization methods into a {@link BlockCodec}.
 *
 * Block types now own their markdown/HTML/text round-trip as methods on the
 * node class (so rendering and serialization live in one file), but the
 * parser/serializers still consume a `BlockCodec`. This is the seam: it reads
 * the optional serialization members off any node-shaped value and produces the
 * codec, so the orchestrators never import a canvas Node.
 *
 * This module is canvas-free — it only reads methods/fields via a structural
 * interface. The canvas dependency enters only where a real node instance is
 * passed in.
 */

import type { Block } from "../loadPage";
import type { TokenType } from "../tokenizer";
import type { BlockCodec, InputCtx, OutputCtx, ParsedTag } from "./types";

/** The serialization slice of a Node — just what {@link codecFromNode} reads. */
export interface SerializableNode {
  readonly type: string;
  readonly types?: readonly string[];
  readonly markdownTokens?: readonly TokenType[];
  readonly htmlTags?: readonly string[];
  outputMarkdown?(block: Block, ctx: OutputCtx): string;
  inputMarkdown?(ctx: InputCtx): Block;
  inputMarkdownTag?(tag: ParsedTag, ctx: InputCtx): Block;
  outputHTML?(block: Block, ctx: OutputCtx): string;
  outputText?(block: Block, ctx: OutputCtx): string;
  assetRefs?(block: Block): string[];
}

/** Build the {@link BlockCodec} for a node from its serialization methods. */
export function codecFromNode(node: SerializableNode): BlockCodec {
  const { outputMarkdown, outputHTML, outputText } = node;
  if (!outputMarkdown || !outputHTML || !outputText) {
    throw new Error(
      `Block type "${node.type}" is missing a serialization output method ` +
        `(needs outputMarkdown, outputHTML, outputText).`,
    );
  }
  return {
    types: node.types ?? [node.type],
    markdown: {
      output: (block, ctx) => outputMarkdown.call(node, block, ctx),
      tokens: node.markdownTokens,
      input: node.inputMarkdown ? (ctx) => node.inputMarkdown!(ctx) : undefined,
      htmlTags: node.htmlTags,
      inputTag: node.inputMarkdownTag
        ? (tag, ctx) => node.inputMarkdownTag!(tag, ctx)
        : undefined,
    },
    html: { output: (block, ctx) => outputHTML.call(node, block, ctx) },
    text: { output: (block, ctx) => outputText.call(node, block, ctx) },
    assetRefs: node.assetRefs ? (block) => node.assetRefs!(block) : undefined,
  };
}

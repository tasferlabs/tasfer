/**
 * Codec for the plain textual family: paragraph + heading1-3.
 *
 * Also the parser's fallback: any block-start token no codec claims (plain
 * text, unknown HTML tags, heading4+ tokens) parses as a paragraph, with the
 * unclaimed token's content flowing into the text via `inlineText()`.
 */

import type { Heading, Paragraph } from "../../rendering/nodes/TextNode";
import type { Block } from "../loadPage";
import { HEADING_1, HEADING_2, HEADING_3, NEWLINE } from "../tokenizer";
import type { BlockCodec, InputCtx, OutputCtx } from "./types";

type TextualBlock = Paragraph | Heading;

const MARKDOWN_PREFIX: Record<string, string> = {
  heading1: "# ",
  heading2: "## ",
  heading3: "### ",
  paragraph: "",
};

const HTML_TAG_NAME: Record<string, string> = {
  heading1: "h1",
  heading2: "h2",
  heading3: "h3",
  paragraph: "p",
};

function headingLevel(ctx: InputCtx): number {
  if (ctx.match(HEADING_1)) return 1;
  if (ctx.match(HEADING_2)) return 2;
  if (ctx.match(HEADING_3)) return 3;
  return 0;
}

export const textCodec: BlockCodec = {
  types: ["paragraph", "heading1", "heading2", "heading3"],

  markdown: {
    tokens: [HEADING_1, HEADING_2, HEADING_3],

    output(block: Block, ctx: OutputCtx): string {
      const b = block as TextualBlock;
      const prefix = MARKDOWN_PREFIX[b.type] ?? "";
      return prefix + ctx.inline(b.charRuns, b.formats);
    },

    input(ctx: InputCtx): Block {
      const level = headingLevel(ctx);
      const { charRuns, formats } = ctx.inlineText();

      if (level > 0) {
        const heading: Heading = {
          id: ctx.nextBlockId(),
          type: `heading${level}` as Heading["type"],
          charRuns,
          formats,
        };
        ctx.match(NEWLINE);
        return heading;
      }

      const paragraph: Paragraph = {
        id: ctx.nextBlockId(),
        type: "paragraph",
        charRuns,
        formats,
      };
      return paragraph;
    },
  },

  html: {
    output(block: Block, ctx: OutputCtx): string {
      const b = block as TextualBlock;
      const tag = HTML_TAG_NAME[b.type] ?? "p";
      const inner = ctx.inline(b.charRuns, b.formats);
      return `<${tag}>${inner}</${tag}>`;
    },
  },

  text: {
    output(block: Block, ctx: OutputCtx): string {
      const b = block as TextualBlock;
      return ctx.inline(b.charRuns, b.formats);
    },
  },
};

/** Codec for the line (horizontal rule / divider) block. */

import type { Line } from "../../rendering/nodes/LineNode";
import type { Block } from "../loadPage";
import { HORIZONTAL_RULE, NEWLINE } from "../tokenizer";
import type { BlockCodec, InputCtx } from "./types";

export const lineCodec: BlockCodec = {
  types: ["line"],

  markdown: {
    tokens: [HORIZONTAL_RULE],

    output(): string {
      return "---";
    },

    input(ctx: InputCtx): Block {
      ctx.match(HORIZONTAL_RULE); // Consume the horizontal rule token
      ctx.match(NEWLINE); // Consume optional newline

      const line: Line = {
        id: ctx.nextBlockId(),
        type: "line",
      };
      return line;
    },
  },

  html: {
    output(): string {
      return "<hr />";
    },
  },

  text: {
    output(): string {
      return "---";
    },
  },
};

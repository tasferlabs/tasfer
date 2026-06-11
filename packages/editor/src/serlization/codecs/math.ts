/**
 * Codec for the math (LaTeX) block.
 *
 * HTML output renders through `ctx.renderMathSVG`, injected by the HTML
 * orchestrator — this module must NOT import `../math` (it boots MathJax at
 * module load, and the codec registry sits on the parser/fuzz import path).
 */

import type { MathBlock } from "../../rendering/nodes/MathNode";
import type { Block } from "../loadPage";
import { MATH_BLOCK, NEWLINE, type VisibleToken } from "../tokenizer";
import { escapeHtml } from "./inline";
import type { BlockCodec, InputCtx, OutputCtx } from "./types";

export const mathCodec: BlockCodec = {
  types: ["math"],

  markdown: {
    tokens: [MATH_BLOCK],

    output(block: Block): string {
      const b = block as MathBlock;
      if (!b.latex) return "";
      if (b.displayMode) {
        return `$$\n${b.latex}\n$$`;
      }
      return `$${b.latex}$`;
    },

    input(ctx: InputCtx): Block {
      ctx.match(MATH_BLOCK);
      const latex = (ctx.previous() as VisibleToken).content;
      ctx.match(NEWLINE);

      const math: MathBlock = {
        id: ctx.nextBlockId(),
        type: "math",
        latex,
        displayMode: true,
      };
      return math;
    },
  },

  html: {
    output(block: Block, ctx: OutputCtx): string {
      const b = block as MathBlock;
      if (!b.latex) return "";
      try {
        if (!ctx.renderMathSVG) throw new Error("no math renderer");
        const svg = ctx.renderMathSVG(b.latex, b.displayMode);
        if (b.displayMode) {
          return `<div style="text-align:center;margin:1em 0;">${svg}</div>`;
        }
        return `<span style="display:inline-block;vertical-align:middle;">${svg}</span>`;
      } catch {
        return `<code>${escapeHtml(b.latex)}</code>`;
      }
    },
  },

  text: {
    output(): string {
      return "";
    },
  },
};

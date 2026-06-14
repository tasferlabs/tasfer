/**
 * line — the horizontal divider block, rendering and serialization in one place.
 *
 * `LineNode` is the on-canvas view: with selection overlays, bounds, and
 * empty-lines plumbing inherited from {@link AtomicNode}, all that's left is
 * "how tall" and "draw the rule". The serialization methods are its
 * markdown/HTML/text round-trip (`---` / `<hr />`), adapted into a BlockCodec by
 * the schema. Both sides share the one `Line` interface declared here.
 */

import { AtomicNode } from "../rendering/nodes/AtomicNode";
import type {
  BlockRuntimeState,
  NodeLayoutCtx,
  NodePaintCtx,
} from "../rendering/nodes/Node";
import type { InputCtx } from "../serlization/codecs/types";
import type { Block } from "../serlization/loadPage";
import {
  HORIZONTAL_RULE,
  NEWLINE,
  type TokenType,
} from "../serlization/tokenizer";
import type { BlockBounds } from "../state-types";

// Line block - horizontal divider/separator
export interface Line extends BlockRuntimeState {
  type: "line";
}

export class LineNode extends AtomicNode<Line> {
  readonly type = "line" as const;

  // ── Rendering ──────────────────────────────────────────────────────────────

  protected intrinsicHeight(c: NodeLayoutCtx): number {
    return c.styles.blocks.line.height;
  }

  protected draw(box: BlockBounds, c: NodePaintCtx): void {
    const s = c.styles.blocks.line;
    c.ctx.save();
    c.ctx.fillStyle = s.color;
    c.ctx.fillRect(box.x, box.y + s.paddingTop, box.width, s.lineHeight);
    c.ctx.restore();
  }

  // ── Serialization ──────────────────────────────────────────────────────────

  readonly markdownTokens: readonly TokenType[] = [HORIZONTAL_RULE];

  outputMarkdown(): string {
    return "---";
  }

  inputMarkdown(ctx: InputCtx): Block {
    ctx.match(HORIZONTAL_RULE); // Consume the horizontal rule token
    ctx.match(NEWLINE); // Consume optional newline

    const line: Line = {
      id: ctx.nextBlockId(),
      type: "line",
    };
    return line;
  }

  outputHTML(): string {
    return "<hr />";
  }

  outputText(): string {
    return "---";
  }
}

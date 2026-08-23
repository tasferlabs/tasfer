/**
 * The `code` block's canvas-free data facet: its shape and its round-trip.
 *
 * The code *node* — painting, layout, editing behavior, and syntax
 * highlighting — is an opt-in package (`@tasfer/code`), which is what keeps
 * the highlight.js grammar set out of every bundle. Everything here stays in
 * core, for two reasons:
 *
 *   - {@link Block} is a deliberately CLOSED union. An open member with a
 *     non-literal `type` would de-discriminate it and break every
 *     `block.type === "…"` narrow across the engine.
 *   - ``` fences are core Markdown. The tokenizer already emits them
 *     (`tryTokenizeCodeBlock`) and `BLOCK_REGISTRY.code` already describes the
 *     CRDT shape, so a document containing code parses, syncs, serializes, and
 *     exports identically whether or not a host installs the node. Without the
 *     node the block simply has no painter and renders as an `UnknownNode` — the
 *     same "preserve and degrade" contract as any unregistered type.
 *
 * The node re-declares this object as its own `codec`, so registering the node
 * and registering this spec describe the same block.
 */

import type { BlockRuntimeState } from "../rendering/nodes/Node";
import { escapeAttr, escapeHtml } from "../serlization/codecs/inline";
import type { NodeCodec } from "../serlization/codecs/types";
import type { CharRun, MarkSpan } from "../serlization/loadPage";
import {
  CODE_BLOCK,
  NEWLINE,
  type VisibleToken,
} from "../serlization/tokenizer";
import { BLOCK_REGISTRY } from "../sync/block-registry";
import { getVisibleTextFromRuns } from "../sync/char-runs";
import type { BlockSpecCore } from "../sync/schema";

/** A code block: editable monospace text (with embedded "\n") plus a language tag. */
export interface CodeBlock extends BlockRuntimeState {
  type: "code";
  charRuns: CharRun[];
  /** Always empty — code carries no inline marks — but kept for the textual shape. */
  formats: MarkSpan[];
  /** Highlighting language hint (e.g. "javascript"); empty when unset. */
  language?: string;
}

/** Markdown/HTML/text round-trip for a code block. Canvas-free. */
export const codeBlockNodeCodec: NodeCodec = {
  markdown: {
    tokens: [CODE_BLOCK],
    input: (ctx) => {
      ctx.match(CODE_BLOCK);
      const raw = (ctx.previous() as VisibleToken).content;
      let code = "";
      let language = "";
      try {
        const parsed = JSON.parse(raw) as {
          code?: string;
          language?: string;
        };
        code = parsed.code ?? "";
        language = parsed.language ?? "";
      } catch {
        // Malformed token payload — fall back to an empty code block.
      }
      ctx.match(NEWLINE);

      const block: CodeBlock = {
        id: ctx.nextBlockId(),
        type: "code",
        charRuns: ctx.rawText(code),
        formats: [],
        language,
      };
      return block;
    },
    output: (block) => {
      const b = block as CodeBlock;
      const text = getVisibleTextFromRuns(b.charRuns);
      return "```" + (b.language ?? "") + "\n" + text + "\n```";
    },
  },
  html: {
    output: (block) => {
      const b = block as CodeBlock;
      const text = getVisibleTextFromRuns(b.charRuns);
      const cls = b.language
        ? ` class="language-${escapeAttr(b.language)}"`
        : "";
      return `<pre><code${cls}>${escapeHtml(text)}</code></pre>`;
    },
  },
  text: {
    output: (block) => getVisibleTextFromRuns((block as CodeBlock).charRuns),
  },
};

/** The `code` type's data registration — descriptor plus round-trip, no node. */
export const codeBlockSpec: BlockSpecCore<"code"> = {
  type: "code",
  descriptor: BLOCK_REGISTRY.code,
  codec: { ...codeBlockNodeCodec, types: ["code"] },
};

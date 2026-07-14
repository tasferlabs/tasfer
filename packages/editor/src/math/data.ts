/**
 * Canvas-free data facet of the optional math feature.
 *
 * Import this entry in workers, persistence code, and Markdown tooling. It
 * registers the CRDT shape, codecs, Markdown syntax, and structured-content
 * adapters without constructing MathNode/MathMark or importing their canvas
 * interaction/selection stack (including the `@cypherkit/tex` layout engine —
 * this entry reaches only `@cypherkit/tex/data`). Interactive hosts normally
 * install the full bundle from `@cypherkit/editor/math` instead, which adds
 * the rendering classes, live input rules, and the clipboard selection
 * serializer.
 */

import type {
  StructuredContentCloneCtx,
  StructuredContentCloneResult,
  SyntaxRule,
} from "../feature-facets";
import { escapeHtml } from "../serlization/codecs/inline";
import type { MarkCodec } from "../serlization/codecs/mark-codec";
import type { BlockCodec, NodeCodec } from "../serlization/codecs/types";
import type { Block, CharRun } from "../serlization/loadPage";
import {
  INLINE_MATH_END,
  INLINE_MATH_START,
  MATH_BLOCK,
  NEWLINE,
  type VisibleToken,
} from "../serlization/tokenizer";
import { BLOCK_REGISTRY } from "../sync/block-registry";
import type {
  BlockSpecCore,
  MarkSpec,
  StructuredKindSpec,
} from "../sync/schema";
import { cloneStructuredDocumentWithFreshIdentities } from "../sync/structured-content";
import {
  type MathMarkAttrs,
  mathStructuredMarkFacet,
} from "./inline-structured";
import { normalizeMathSource } from "./source";
import {
  getStructuredMathSource,
  MATH_STRUCTURED_KIND,
  mathContentIdForBlock,
  parseMathDocumentInit,
  structuredToMathDocument,
  validateStructuredMathDocument,
} from "./structured";
import { printMathDocument as printMathDocumentValue } from "@cypherkit/tex/data";

export { normalizeMathSource } from "./source";

export type MathBlockAttrs = {
  readonly displayMode: boolean;
};

export type MathDataExtension = {
  readonly blocks: readonly [BlockSpecCore<"math", MathBlockAttrs>];
  readonly marks: readonly [MarkSpec<"math", MathMarkAttrs>];
  readonly structuredKinds: readonly [StructuredKindSpec];
};

type MathTextBlock = Pick<Block, "id" | "structuredContent"> & {
  readonly charRuns: CharRun[];
};

/** Serialization facet shared by the headless spec and interactive MathNode. */
export const mathBlockNodeCodec: NodeCodec = {
  markdown: {
    tokens: [MATH_BLOCK],
    output: (block) => {
      const latex = visibleSource(block as MathTextBlock);
      return latex ? `$$\n${latex}\n$$` : "";
    },
    input: (ctx) => {
      ctx.match(MATH_BLOCK);
      const latex = (ctx.previous() as VisibleToken).content;
      ctx.match(NEWLINE);
      // A display block's content lives only in its authority document; the
      // block's flat text stays empty. The deterministic default allocator is
      // parse-scoped — the import path re-addresses identities when the block
      // becomes CRDT ops.
      const id = ctx.nextBlockId();
      const contentId = mathContentIdForBlock(id);
      const init = parseMathDocumentInit(normalizeMathSource(latex), {
        contentId,
      });
      return {
        id,
        type: "math",
        charRuns: [],
        formats: [],
        structuredContent: { [contentId]: init.document },
        displayMode: true,
      } as unknown as Block;
    },
  },
  html: {
    output: (block, ctx) => {
      const latex = visibleSource(block as MathTextBlock);
      if (!latex) return "";
      if (ctx.preferSource) {
        return `<div style="text-align:center;margin:1em 0;">$$${escapeHtml(latex)}$$</div>`;
      }
      try {
        if (!ctx.renderReplacement) throw new Error("no math renderer");
        const rendered = ctx.renderReplacement("math", latex, true);
        return `<div style="text-align:center;margin:1em 0;">${rendered}</div>`;
      } catch {
        return `<code>${escapeHtml(latex)}</code>`;
      }
    },
  },
  text: {
    output: (block) => {
      const latex = visibleSource(block as MathTextBlock);
      return latex ? `$$${latex}$$` : "";
    },
  },
};

/** Full block codec consumed by DataSchema. */
export const mathBlockCodec: BlockCodec = {
  types: ["math"],
  ...mathBlockNodeCodec,
};

/** Serialization facet shared by the headless mark spec and MathMark. */
export const mathMarkCodec: MarkCodec = {
  type: "math",
  toMarkdown: (text) => `$${text}$`,
  toText: (text) => `$${text}$`,
  tokens: { start: INLINE_MATH_START, end: INLINE_MATH_END },
  html: {
    priority: 0,
    replace: true,
    render: (_inner, _mark, ctx) => {
      const latex = ctx.text;
      if (ctx.preferSource) return `$${ctx.escapeHtml(latex)}$`;
      try {
        if (!ctx.renderReplacement) throw new Error("no math renderer");
        return ctx.renderReplacement("math", latex, false);
      } catch {
        return `<code>$${ctx.escapeHtml(latex)}$</code>`;
      }
    },
  },
};

/**
 * `$$…$$` display-math recognizer, carried on the math BLOCK spec — the codec
 * that claims its MATH_BLOCK token rides the same spec.
 */
export const mathDisplaySyntaxRule = {
  id: "math.display-dollar-fence",
  scope: "block",
  priority: 100,
  match: ({ source, offset }) => {
    if (!source.startsWith("$$", offset)) return undefined;

    let cursor = offset + 2;
    if (source[cursor] === "\n") cursor += 1;
    else if (source[cursor] === "\r" && source[cursor + 1] === "\n") {
      cursor += 2;
    }
    const contentStart = cursor;
    const close = source.indexOf("$$", cursor);
    if (close < 0) return undefined;

    let latex = source.slice(contentStart, close);
    if (latex.endsWith("\n")) latex = latex.slice(0, -1);
    if (latex.endsWith("\r")) latex = latex.slice(0, -1);

    const fenceEnd = close + 2;
    let end = fenceEnd;
    const tokens: Array<{
      type: string;
      content?: string;
      raw?: string;
    }> = [
      {
        type: MATH_BLOCK,
        content: latex,
        raw: source.slice(offset, fenceEnd),
      },
    ];
    if (source[end] === "\n") {
      end += 1;
      tokens.push({ type: NEWLINE });
    } else if (source[end] === "\r" && source[end + 1] === "\n") {
      end += 2;
      tokens.push({ type: NEWLINE });
    }
    return { length: end - offset, tokens };
  },
} as const satisfies SyntaxRule;

/**
 * `$…$` inline-math recognizer, carried on the math MARK spec — the mark codec
 * claims the INLINE_MATH_START/END tokens it emits.
 */
export const mathInlineSyntaxRule = {
  id: "math.inline-dollar-delimiter",
  scope: "inline",
  priority: 50,
  match: ({ source, offset }) => {
    if (source[offset] !== "$") return undefined;
    let close = offset + 1;
    while (
      close < source.length &&
      source[close] !== "\n" &&
      source[close] !== "\r" &&
      source[close] !== "$"
    ) {
      close += 1;
    }
    if (source[close] !== "$" || close === offset + 1) return undefined;
    return {
      length: close - offset + 1,
      tokens: [
        { type: INLINE_MATH_START, content: "$", raw: "$" },
        { type: "text", content: source.slice(offset + 1, close) },
        { type: INLINE_MATH_END, content: "$", raw: "$" },
      ],
    };
  },
} as const satisfies SyntaxRule;

/** Canonical LaTeX of one structured math document (kind `source` adapter). */
function mathStructuredContentSource(
  document: Parameters<typeof validateStructuredMathDocument>[0],
): string | undefined {
  const math = structuredToMathDocument(document);
  return math ? printMathDocumentValue(math) : undefined;
}

/** Re-address a display equation when snapshot restore mints a new block id. */
export function cloneMathStructuredContent({
  document,
  targetBlockId,
  identities,
}: StructuredContentCloneCtx): StructuredContentCloneResult | undefined {
  const contentId =
    document.authority === "block"
      ? mathContentIdForBlock(targetBlockId)
      : identities.nextId();
  const cloned = validateStructuredMathDocument(
    cloneStructuredDocumentWithFreshIdentities(document, contentId, identities),
  );
  return cloned ? { contentId, document: cloned } : undefined;
}

/**
 * Build the persistence/serialization facet of math. Everything registers on
 * the spec that owns it: the block spec carries the display syntax rule, the
 * mark spec carries the inline rule and the structured-mark behavior, and the
 * shared structured KIND (display blocks and inline supplemental attachments
 * both use it) carries the snapshot clone adapter.
 *
 * Live input rules and the clipboard selection serializer intentionally belong
 * to the full interactive extension, so importing this worker-safe entry
 * cannot reach the editor selection stack, the tex layout engine, the canvas,
 * or the rendering graph.
 */
export function mathDataExtension(): MathDataExtension {
  return {
    blocks: [
      {
        type: "math",
        descriptor: BLOCK_REGISTRY.math,
        codec: mathBlockCodec,
        markdownSyntax: [mathDisplaySyntaxRule],
      },
    ],
    marks: [
      {
        type: "math",
        codec: mathMarkCodec,
        markdownSyntax: [mathInlineSyntaxRule],
        structured: mathStructuredMarkFacet,
      },
    ],
    structuredKinds: [
      {
        kind: MATH_STRUCTURED_KIND,
        clone: cloneMathStructuredContent,
        source: mathStructuredContentSource,
      },
    ],
  };
}

function visibleSource(block: MathTextBlock): string {
  return getStructuredMathSource(block) ?? "";
}

// The stable structured model belongs to the feature's data surface too. Its
// ids and the adapter below target editor core's generic structured-content
// CRDT. Reducers and workers only need these adapters; tree editing and
// selection live on the full interactive math entry.
export * from "./inline-structured";
export * from "./structured";
// Pure structured edits are useful to headless/custom hosts and depend only on
// the generic structured CRDT plus the document adapter. Layout/state bridging
// stays on the full entry.
export * from "./tree-edit";
/**
 * Editable TeX AST node. The alias keeps it distinct from the interactive
 * `MathNode` renderer exported by the full `@cypherkit/editor/math` entry.
 */
export type { MathNode as MathDocumentNode } from "@cypherkit/tex/data";
export {
  type AllocatedIdentity,
  createDeterministicIdentityAllocator,
  type IdentityAllocator,
  type MathDelimited,
  type MathDocument,
  mathDocumentsSemanticallyEqual,
  type MathFraction,
  type MathItemId,
  type MathMatrix,
  type MathMatrixCell,
  type MathMatrixRow,
  type MathNode,
  type MathOperator,
  type MathRadical,
  type MathRawLatex,
  type MathRawText,
  type MathRoot,
  type MathRow,
  type MathScripts,
  type MathSymbol,
  type MathSymbolClass,
  type MathText,
  type MathTextVariant,
  parseAllocatedIdentity,
  parseMathDocument,
  type ParseMathDocumentOptions,
  printMathDocument,
  printMathRow,
} from "@cypherkit/tex/data";

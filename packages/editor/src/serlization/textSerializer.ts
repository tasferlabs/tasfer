/**
 * Plain-text serializer — orchestrator only.
 *
 * Per-block-type text lives in the block codecs (./codecs, sourced from each
 * node's `outputText`). This file owns only the cross-block concern: joining
 * blocks with blank lines. Mirrors serializer.ts / htmlSerializer.ts so that
 * the plain-text representation is node-owned too — no per-type switch.
 */

import { getBaseDataSchema } from "../baseDataSchema";
import type { DataSchema } from "../sync/schema";
import type { OutputCtx } from "./codecs";
import { inlineToText } from "./codecs/inline";
import type { Block } from "./loadPage";

interface TextSerializeOptions {
  /** Block/mark types in play. Defaults to the built-in set. */
  schema?: DataSchema;
}

export function serializeToText(
  blocks: Block[],
  options: TextSerializeOptions = {},
): string {
  const schema = options.schema ?? getBaseDataSchema();
  const live = blocks.filter((block) => !block.deleted);
  if (live.length === 0) return "";

  const ctx: OutputCtx = {
    format: "text",
    inline: (charRuns, formats) => inlineToText(charRuns, formats, schema),
    mapAssetUrl: (url) => url,
  };

  return live
    .map((block) => {
      const blockCtx: OutputCtx = {
        ...ctx,
        inline: (charRuns, formats) =>
          inlineToText(charRuns, formats, schema, block.structuredContent),
      };
      return schema.getCodec(block.type)?.text.output(block, blockCtx) ?? "";
    })
    .join("\n\n");
}

/**
 * Plain-text serializer — the degenerate format: visible text only,
 * formatting dropped. Per-block-type output lives in the block codecs.
 */

import { baseDataSchema, type DataSchema } from "../sync/schema";
import type { OutputCtx } from "./codecs";
import { inlineToText } from "./codecs/inline";
import type { Block } from "./loadPage";

export function serializeToText(
  blocks: Block[],
  schema: DataSchema = baseDataSchema,
): string {
  const ctx: OutputCtx = {
    format: "text",
    inline: (charRuns) => inlineToText(charRuns),
    mapAssetUrl: (url) => url,
  };

  return blocks
    .filter((block) => !block.deleted)
    .map((block) => schema.getCodec(block.type)?.text.output(block, ctx) ?? "")
    .join("\n");
}

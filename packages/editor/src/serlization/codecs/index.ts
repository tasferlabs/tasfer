/**
 * Codec barrel — block-serialization types.
 *
 * Codec VALUES are no longer kept in a static registry here: each block type
 * carries its serialization as a single `codec` object on its node, and the
 * internal `codecFromNode` (./from-node) adapts that into a `BlockCodec`
 * (injecting the node's types).
 * The default schema assembled from those nodes is `baseDataSchema`
 * (../../baseDataSchema); per-instance lookup goes through the `DataSchema` the
 * editor/parser/serializers already hold.
 */

export type {
  BlockCodec,
  HtmlCodec,
  InputCtx,
  MarkdownCodec,
  NodeCodec,
  OutputCtx,
  ParsedTag,
  ReplacementRenderer,
  SerialFormat,
  TextCodec,
} from "./types";

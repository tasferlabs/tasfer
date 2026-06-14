/**
 * Codec barrel — block-serialization types + the node→codec adapter.
 *
 * Codec VALUES are no longer kept in a static registry here: each block type
 * carries its serialization as methods on its node, and `codecFromNode` adapts
 * a node into a `BlockCodec`. The default schema assembled from those nodes is
 * `baseDataSchema` (../../baseDataSchema); per-instance lookup goes through the
 * `DataSchema` the editor/parser/serializers already hold.
 */

export { codecFromNode, type SerializableNode } from "./from-node";
export type {
  BlockCodec,
  HtmlCodec,
  InputCtx,
  MarkdownCodec,
  OutputCtx,
  ParsedTag,
  SerialFormat,
  TextCodec,
} from "./types";

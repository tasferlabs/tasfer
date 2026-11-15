/**
 * `@tasfer/editor/serlization/codecs`: kept so 0.2 imports keep working.
 *
 * @deprecated Most of it is exported from `@tasfer/editor`: import it from
 * there. The names marked "not part of the public API" have no new home. This
 * entry point will be removed in a later release.
 */

export {
  /** @deprecated Import it from `@tasfer/editor` instead. */
  type BlockCodec,
  /** @deprecated Import it from `@tasfer/editor` instead. */
  type HtmlCodec,
  /** @deprecated Import it from `@tasfer/editor` instead. */
  type InputCtx,
  /** @deprecated Import it from `@tasfer/editor` instead. */
  type MarkdownCodec,
  /** @deprecated Import it from `@tasfer/editor` instead. */
  type NodeCodec,
  /** @deprecated Import it from `@tasfer/editor` instead. */
  type OutputCtx,
  /** @deprecated Import it from `@tasfer/editor` instead. */
  type ParsedTag,
  /** @deprecated Import it from `@tasfer/editor` instead. */
  type ReplacementRenderer,
  /** @deprecated Import it from `@tasfer/editor` instead. */
  type SerialFormat,
  /** @deprecated Import it from `@tasfer/editor` instead. */
  type TextCodec,
} from "../index";
export {
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  codecFromNode,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  type SerializableNode,
} from "../serlization/codecs/from-node";

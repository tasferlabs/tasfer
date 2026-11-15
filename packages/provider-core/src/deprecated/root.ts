/**
 * Exports that `@tasfer/provider-core` no longer offers, kept so 0.2 imports keep
 * working. None of them is part of the public API any more.
 *
 * @deprecated Each will be removed in a later release.
 */

export {
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  decodeMessage,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  encodeMessage,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  type WireMessage,
} from "../wire";

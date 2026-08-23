/**
 * @tasfer/code — the syntax-highlighted code block for `@tasfer/editor`.
 *
 * Install it to give code blocks a painter; the block type itself is core (see
 * {@link codeExtension}). This package owns the highlight.js grammar set, which
 * is why it is a package and not part of the engine.
 */

export { codeExtension, type CodeFeatureExtension } from "./code-extension";
export {
  CODE_LANGUAGES,
  codeLanguageLabel,
  type CodeLanguageOption,
  type CodeToken,
  type CodeTokenKind,
  highlightLine,
} from "./code-highlight";
export { CodeNode, INDENT_CODE, OUTDENT_CODE } from "./CodeNode";

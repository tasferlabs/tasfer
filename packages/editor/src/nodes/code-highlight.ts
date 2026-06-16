/**
 * Syntax highlighting for code blocks, backed by a real grammar engine
 * (highlight.js via {@link https://github.com/wooorm/lowlight | lowlight}).
 *
 * We expose a single primitive — {@link highlightLine} — which tokenizes ONE
 * line at a time into colored spans (keyword / string / comment / number /
 * function / plain). The canvas paint pass renders code line-by-line (a logical
 * line may also be soft-wrapped into several visual lines), so a per-line,
 * synchronous tokenizer is exactly what the renderer needs.
 *
 * Per-line means there is no cross-line state: a multi-line block comment or
 * template string is only colored on the lines where its delimiters appear.
 * That is an accepted trade-off for a synchronous highlighter that runs inside
 * the paint pass, and it matches how the renderer already feeds us text.
 *
 * The lowlight engine is created once as an isolated instance via
 * {@link createLowlight} — it is NOT the highlight.js global singleton and never
 * touches `window`/`document`. Its grammar registry is immutable, read-only, and
 * identical for every editor on the page (registering a grammar is idempotent),
 * so a single shared instance is safe across multiple editor instances — it is a
 * constant lookup table, not per-editor mutable state.
 *
 * `highlightLine` is a pure function of (line, language) with no shared mutable
 * state.
 */

import type { Element, Root, RootContent } from "hast";
import { common, createLowlight } from "lowlight";

export type CodeTokenKind =
  | "keyword"
  | "string"
  | "comment"
  | "number"
  | "function"
  | "plain";

export interface CodeToken {
  readonly text: string;
  readonly kind: CodeTokenKind;
}

// A single isolated engine, seeded with highlight.js's "common" grammar set
// (~35 popular languages — a superset of CODE_LANGUAGES below). Created once as
// a shared, read-only constant; see the file header for why that is safe.
const lowlight = createLowlight(common);

/**
 * Map a highlight.js token class (the `hljs-*` entries on a hast element's
 * `className`) to one of our six render kinds. highlight.js emits a far richer
 * set of classes than the theme colors, so several collapse onto each kind:
 * literals/types/built-ins read as keywords, regex/char read as strings, and
 * every `title.*` (function and class names) reads as a function call.
 */
function classToKind(className: readonly (string | number)[]): CodeTokenKind {
  for (const raw of className) {
    const cls = String(raw);
    switch (cls) {
      case "hljs-keyword":
      case "hljs-built_in":
      case "hljs-literal":
      case "hljs-type":
      case "hljs-symbol":
      case "hljs-meta":
        return "keyword";
      case "hljs-string":
      case "hljs-regexp":
      case "hljs-char":
      case "hljs-meta-string":
      case "hljs-subst":
        return "string";
      case "hljs-comment":
      case "hljs-quote":
        return "comment";
      case "hljs-number":
        return "number";
      case "hljs-title":
      case "hljs-function":
      case "hljs-attr":
      case "hljs-attribute":
        return "function";
    }
  }
  return "plain";
}

// =============================================================================
// Selectable language catalog (drives the host's code-block language picker)
// =============================================================================

/** One selectable entry in the code-block language picker. */
export interface CodeLanguageOption {
  /** Canonical id stored on the block (and emitted to the markdown fence). */
  readonly id: string;
  /** Human-readable label shown in the picker / language tag. */
  readonly label: string;
  /**
   * Extra strings (besides `id` and `label`) that resolve to this option — fence
   * tokens this language is commonly written as. Used both to match an imported
   * fence (e.g. "js", "c++") back to its label and to widen picker search.
   */
  readonly aliases?: readonly string[];
}

/**
 * Languages offered in the picker. Every one is a `common` highlight.js grammar
 * and so gets real syntax coloring; `id: ""` is the un-tagged "Plain Text"
 * default (rendered with no highlighting).
 */
export const CODE_LANGUAGES: readonly CodeLanguageOption[] = [
  { id: "", label: "Plain Text" },
  { id: "bash", label: "Bash", aliases: ["sh", "shell", "zsh"] },
  { id: "c", label: "C" },
  { id: "cpp", label: "C++", aliases: ["c++"] },
  { id: "csharp", label: "C#", aliases: ["cs"] },
  { id: "css", label: "CSS" },
  { id: "go", label: "Go", aliases: ["golang"] },
  { id: "html", label: "HTML", aliases: ["xml"] },
  { id: "java", label: "Java" },
  { id: "javascript", label: "JavaScript", aliases: ["js", "jsx"] },
  { id: "json", label: "JSON" },
  { id: "kotlin", label: "Kotlin", aliases: ["kt"] },
  { id: "markdown", label: "Markdown", aliases: ["md"] },
  { id: "php", label: "PHP" },
  { id: "python", label: "Python", aliases: ["py"] },
  { id: "rust", label: "Rust", aliases: ["rs"] },
  { id: "sql", label: "SQL" },
  { id: "swift", label: "Swift" },
  { id: "typescript", label: "TypeScript", aliases: ["ts", "tsx"] },
  { id: "yaml", label: "YAML", aliases: ["yml"] },
];

/**
 * Resolve a stored language string to its display label. Matches by id first,
 * then by alias (so an imported "js" fence shows "JavaScript"); an unknown
 * non-empty tag is shown verbatim, and an empty tag falls back to "Plain Text".
 */
export function codeLanguageLabel(language: string | undefined): string {
  const lang = (language ?? "").toLowerCase().trim();
  if (!lang) return "Plain Text";
  for (const opt of CODE_LANGUAGES) {
    if (opt.id === lang || opt.aliases?.includes(lang)) return opt.label;
  }
  return language ?? "Plain Text";
}

/**
 * Resolve a stored/fence language string to a grammar registered in `lowlight`,
 * or `null` when it should render as plain text. Tries the value directly, then
 * maps a known alias (e.g. "js" → "javascript", "c++" → "cpp") to its canonical
 * id from the picker catalog.
 */
function resolveLanguage(language: string): string | null {
  const lang = language.toLowerCase().trim();
  if (!lang) return null;
  if (lowlight.registered(lang)) return lang;
  for (const opt of CODE_LANGUAGES) {
    if (opt.id === lang || opt.aliases?.includes(lang)) {
      return lowlight.registered(opt.id) ? opt.id : null;
    }
  }
  return null;
}

/**
 * Walk a hast subtree (the output of `lowlight.highlight`) in document order,
 * emitting one {@link CodeToken} per text leaf. Each leaf's kind is the kind of
 * the nearest enclosing highlighted element (`inherited`), so nested tokens
 * (e.g. punctuation inside a template string) take the inner-most class. The
 * concatenated token text reconstructs the input exactly.
 */
function collectTokens(
  node: Root | RootContent,
  inherited: CodeTokenKind,
  out: CodeToken[],
): void {
  if (node.type === "text") {
    if (node.value.length > 0) pushMerged(out, node.value, inherited);
    return;
  }
  if (node.type === "element" || node.type === "root") {
    const kind =
      node.type === "element"
        ? mostSpecific((node as Element).properties?.className, inherited)
        : inherited;
    for (const child of node.children) collectTokens(child, kind, out);
  }
}

/** An element's own kind, falling back to the inherited one when it has none. */
function mostSpecific(
  className: unknown,
  inherited: CodeTokenKind,
): CodeTokenKind {
  if (!Array.isArray(className)) return inherited;
  const kind = classToKind(className);
  return kind === "plain" ? inherited : kind;
}

/** Append `text`, coalescing it into the previous token when kinds match. */
function pushMerged(out: CodeToken[], text: string, kind: CodeTokenKind): void {
  const last = out[out.length - 1];
  if (last && last.kind === kind) {
    out[out.length - 1] = { text: last.text + text, kind };
  } else {
    out.push({ text, kind });
  }
}

/**
 * Tokenize a single line of `code` in `language` into colored spans. An empty
 * line yields no tokens; an empty/unknown language yields a single plain token.
 * The concatenated token text always reconstructs `line` exactly.
 */
export function highlightLine(line: string, language: string): CodeToken[] {
  if (line.length === 0) return [];

  const lang = resolveLanguage(language);
  if (lang === null) return [{ text: line, kind: "plain" }];

  // highlight.js degrades gracefully on a syntactically-incomplete fragment
  // (a single wrapped/standalone line) rather than throwing.
  const tree = lowlight.highlight(lang, line);
  const tokens: CodeToken[] = [];
  collectTokens(tree, "plain", tokens);
  return tokens;
}

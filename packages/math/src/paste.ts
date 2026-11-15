import type { FeaturePasteRule } from "@tasfer/editor/feature-facets";
import {
  balanceBraces,
  escapeStrayCloseBraces,
  isValidLatex,
  normalizeLatex,
} from "@tasfer/tex";

/**
 * Returns `true` when pasted text is clearly LaTeX, for example text with a
 * `\command` or `x_{1}`.
 *
 * Plain words, simple sums, URLs, file names, text over several lines, text
 * with `$` and text with unbalanced braces return `false`. They may be valid
 * TeX, but they are not meant as math.
 */
export function isUnambiguousLatexPaste(text: string): boolean {
  const latex = text.trim();
  if (
    !latex ||
    latex.includes("\n") ||
    latex.includes("\r") ||
    latex.includes("$") ||
    !isValidLatex(latex)
  ) {
    return false;
  }

  if (
    balanceBraces(latex).changed ||
    escapeStrayCloseBraces(latex) !== latex ||
    normalizeLatex(latex).changed
  ) {
    return false;
  }

  // URLs and file names are valid TeX but their `_`, `-` and `/` are not math.
  if (
    /[a-z][a-z0-9+.-]*:\/\/|(?:^|[^\w])www\./i.test(latex) ||
    /^[\p{L}\p{N}_.-]+\.[A-Za-z][A-Za-z0-9]{1,4}$/u.test(latex)
  ) {
    return false;
  }

  if (/\\[A-Za-z]+/.test(latex) || /\\[^A-Za-z\s]/.test(latex)) {
    return true;
  }

  if (/(?:^|[^\\])[_^]\{[^{}\n]+\}/u.test(latex)) return true;

  const script = latex.match(/[_^][\p{L}\p{N}]/u);
  if (!script || script.index === undefined) return false;
  const base = latex.slice(0, script.index).match(/[\p{L}\p{N}]+$/u)?.[0];
  return (base?.length ?? 0) <= 2 || /[=+\-*/<>]/.test(latex);
}

/**
 * Paste rule that turns pasted text into an inline formula when the text is
 * clearly LaTeX, such as `\frac{a}{b}` or `x^2` (never a URL or a file name).
 * {@link mathExtension} already includes it.
 *
 * @group Setup
 */
export const mathPasteRule: FeaturePasteRule = {
  id: "math.paste.raw-latex",
  priority: 100,
  requiresMark: "math",
  transform: (text) => {
    const latex = text.trim();
    return isUnambiguousLatexPaste(latex) ? `$${latex}$` : undefined;
  },
};

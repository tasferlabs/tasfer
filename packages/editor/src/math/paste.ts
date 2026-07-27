import type { FeaturePasteRule } from "../feature-facets";
import {
  balanceBraces,
  escapeStrayCloseBraces,
  isValidLatex,
  normalizeLatex,
} from "@tasfer/tex";

/**
 * Raw words and arithmetic are valid TeX too, so only recognize source carrying
 * syntax that is unambiguously intended for a LaTeX parser.
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

  if (/\\[A-Za-z]+/.test(latex) || /\\[^A-Za-z\s]/.test(latex)) {
    return true;
  }

  if (/(?:^|[^\\])[_^]\{[^{}\n]+\}/u.test(latex)) return true;

  const script = latex.match(/[_^][\p{L}\p{N}]/u);
  if (!script || script.index === undefined) return false;
  const base = latex.slice(0, script.index).match(/[\p{L}\p{N}]+$/u)?.[0];
  return (base?.length ?? 0) <= 2 || /[=+\-*/<>]/.test(latex);
}

export const mathPasteRule: FeaturePasteRule = {
  id: "math.paste.raw-latex",
  priority: 100,
  requiresMark: "math",
  transform: (text) => {
    const latex = text.trim();
    return isUnambiguousLatexPaste(latex) ? `$${latex}$` : undefined;
  },
};

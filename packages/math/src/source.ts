import { balanceBraces, escapeStrayCloseBraces } from "@tasfer/tex/data";

/**
 * Fixes broken braces in imported LaTeX. A stray `}` becomes `\}`, and missing
 * `}` are added at the end. LaTeX with balanced braces comes back unchanged.
 */
export function normalizeMathSource(latex: string): string {
  const escaped = escapeStrayCloseBraces(latex);
  const balanced = balanceBraces(escaped);
  if (!balanced.changed) return escaped;
  return balanced.inserts.reduce(
    (source, insert) => source + insert.text,
    escaped,
  );
}

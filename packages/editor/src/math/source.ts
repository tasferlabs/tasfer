import { balanceBraces, escapeStrayCloseBraces } from "@cypherkit/tex/data";

/** Make imported source brace-safe without changing already-valid LaTeX. */
export function normalizeMathSource(latex: string): string {
  const escaped = escapeStrayCloseBraces(latex);
  const balanced = balanceBraces(escaped);
  if (!balanced.changed) return escaped;
  return balanced.inserts.reduce(
    (source, insert) => source + insert.text,
    escaped,
  );
}

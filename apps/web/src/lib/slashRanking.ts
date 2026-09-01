/**
 * Relevance ranking for the editor's slash menu.
 *
 * The menu used to be a plain substring filter, which let "table" match the
 * *descriptions* "Add a sui**table** image." and "Edi**table** code block" and
 * list them ahead of the Table block itself. Ranking is now score-based, on top
 * of the same `scoreMatch` the command palette uses: label first, keywords
 * next, description last — and a description only counts when the query sits
 * at a word boundary, never buried inside another word.
 *
 * Pure and DOM-free so it can be unit-tested; the React list only renders the
 * result.
 */
import { scoreMatch } from "./actionRanking";

export interface RankableSlashItem {
  label: string;
  description: string;
  keywords?: readonly string[];
}

/** Word-boundary substring or better in `scoreMatch` terms (see its base tiers). */
const DESCRIPTION_MIN = 0.7;

/**
 * Best relevance of `item` for `query` in [0, 1]; 0 means "hide it".
 * Labels score at full weight, keywords slightly below, and descriptions lower
 * still so a block named after the query always outranks one that merely
 * mentions it.
 */
export function scoreSlashItem(
  item: RankableSlashItem,
  query: string,
): number {
  let score = scoreMatch(item.label, query);
  for (const kw of item.keywords ?? []) {
    score = Math.max(score, scoreMatch(kw, query) * 0.9);
  }
  const desc = scoreMatch(item.description, query);
  if (desc >= DESCRIPTION_MIN) {
    score = Math.max(score, desc * 0.5);
  }
  return score;
}

/**
 * Filter `items` to those matching `query` and order them best-first. Ties keep
 * the original (curated) order; an empty query returns the list untouched.
 */
export function rankSlashItems<T extends RankableSlashItem>(
  items: readonly T[],
  query: string,
): T[] {
  if (!query.trim()) return [...items];
  return items
    .map((item, index) => ({ item, index, score: scoreSlashItem(item, query) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.item);
}

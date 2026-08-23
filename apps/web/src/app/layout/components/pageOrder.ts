import type { IListPage } from "../../api/pages.api";

/** Sort by order, tiebroken by id to match the engine's deterministic order. */
export const byOrder = (a: IListPage, b: IListPage) =>
  a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Pick an order value strictly between two neighbours (null = open end). */
export function midOrder(lower: number | null, upper: number | null): number {
  if (lower === null && upper === null) return 1;
  if (lower === null) return upper! - 1;
  if (upper === null) return lower + 1;
  return (lower + upper) / 2;
}

/**
 * Compute the target order for inserting before/after `targetPageId` within a
 * sibling list that does NOT contain the page being placed. Returns the new
 * order plus the ids that would bracket it (used for no-op detection).
 */
export function placeRelative(
  others: IListPage[],
  targetPageId: string,
  position: "before" | "after",
): { order: number; lowerId: string | null; upperId: string | null } | null {
  const ti = others.findIndex((p) => p.id === targetPageId);
  if (ti === -1) return null;
  const insertIdx = position === "after" ? ti + 1 : ti;
  const lower = others[insertIdx - 1] ?? null;
  const upper = others[insertIdx] ?? null;
  return {
    order: midOrder(lower?.order ?? null, upper?.order ?? null),
    lowerId: lower?.id ?? null,
    upperId: upper?.id ?? null,
  };
}

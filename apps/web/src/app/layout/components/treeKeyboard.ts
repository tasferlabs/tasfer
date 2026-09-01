/**
 * Keyboard navigation for the sidebar page tree.
 *
 * The tree is a set of independently mounted rows — every subtree runs its own
 * page query — so there is no single model to walk. Instead each row publishes
 * what the keyboard needs as data attributes, the focused row reads all of
 * them back in paint order, and the pure helpers here decide where to go.
 * Keeping the decision pure keeps it testable without a DOM.
 */

/** What a row tells the keyboard about itself. */
export type TreeRow = {
  id: string;
  parentId: string | null;
  expanded: boolean;
  hasChildren: boolean;
};

/** A key press, after physical keys are mapped through text direction. */
export type TreeKey =
  | "next"
  | "prev"
  | "expand"
  | "collapse"
  | "first"
  | "last"
  | "open"
  | "select";

export type TreeMove =
  | { type: "focus"; index: number }
  | { type: "expand" }
  | { type: "collapse" }
  | { type: "open" }
  | { type: "select" };

/**
 * Right always means "go deeper" and Left "go shallower", which in a
 * right-to-left layout are the opposite physical arrows.
 */
export function logicalTreeKey(key: string, rtl: boolean): TreeKey | null {
  switch (key) {
    case "ArrowDown":
      return "next";
    case "ArrowUp":
      return "prev";
    case "ArrowRight":
      return rtl ? "collapse" : "expand";
    case "ArrowLeft":
      return rtl ? "expand" : "collapse";
    case "Home":
      return "first";
    case "End":
      return "last";
    case "Enter":
      return "open";
    case " ":
      return "select";
    default:
      return null;
  }
}

/**
 * Rows the user can actually see, in paint order. A row is visible when its
 * parent is visible and expanded. Rows are read from the DOM, and a subtree
 * that was just collapsed stays mounted while it animates shut, so the parent's
 * own expanded flag is what decides — not whether the child is still there.
 */
export function visibleTreeRows<T extends TreeRow>(rows: T[]): T[] {
  const visibleIds = new Set<string>();
  const visible: T[] = [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const row of rows) {
    const parent = row.parentId ? byId.get(row.parentId) : undefined;
    // A parent that is not in the list is outside the tree (the root), so the
    // row is a top-level row of its space.
    const shown = !parent || (parent.expanded && visibleIds.has(parent.id));
    if (!shown) continue;
    visibleIds.add(row.id);
    visible.push(row);
  }
  return visible;
}

/**
 * What a key does on the row at `index` of `rows` (the visible rows, in
 * order). Follows the usual tree convention: Right expands a closed row and
 * steps into an open one; Left closes an open row and climbs out of a closed
 * one. Returns null when the key has nowhere to go.
 */
export function resolveTreeKey(
  key: TreeKey,
  rows: TreeRow[],
  index: number,
): TreeMove | null {
  const row = rows[index];
  if (!row) return null;
  const focus = (i: number): TreeMove | null =>
    i >= 0 && i < rows.length && i !== index
      ? { type: "focus", index: i }
      : null;

  switch (key) {
    case "next":
      return focus(index + 1);
    case "prev":
      return focus(index - 1);
    case "first":
      return focus(0);
    case "last":
      return focus(rows.length - 1);
    case "expand": {
      if (!row.expanded) return row.hasChildren ? { type: "expand" } : null;
      const child = rows[index + 1];
      return child && child.parentId === row.id ? focus(index + 1) : null;
    }
    case "collapse": {
      if (row.expanded) return { type: "collapse" };
      if (!row.parentId) return null;
      return focus(rows.findIndex((r) => r.id === row.parentId));
    }
    case "open":
      return { type: "open" };
    case "select":
      return { type: "select" };
  }
}

export type DomTreeRow = TreeRow & { element: HTMLElement };

/**
 * Every mounted row under `scope`, in DOM (= paint) order. `scope` is the
 * nearest `[data-page-tree]` container, so a second sidebar on the page never
 * leaks in. Rows publish `data-page-row` (their id), `data-page-parent`,
 * `data-page-expanded` and `data-page-has-children`.
 */
export function readTreeRows(scope: ParentNode): DomTreeRow[] {
  const rows: DomTreeRow[] = [];
  for (const element of scope.querySelectorAll<HTMLElement>(
    "[data-page-row]",
  )) {
    const id = element.getAttribute("data-page-row");
    if (!id) continue;
    rows.push({
      element,
      id,
      parentId: element.getAttribute("data-page-parent") || null,
      expanded: element.getAttribute("data-page-expanded") === "true",
      hasChildren: element.getAttribute("data-page-has-children") === "true",
    });
  }
  return rows;
}

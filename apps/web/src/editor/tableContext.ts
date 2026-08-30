/**
 * Public-API bridge used by app chrome while a table owns the nested caret.
 *
 * The engine's own table commands read the caret out of editor state; the host
 * chrome needs the same answer for a React render, where it holds only the
 * public snapshot. This resolves the caret's grid through `query.content`, the
 * way `treeMath.ts` next door resolves the caret's formula.
 */

import { createContext, useContext } from "react";
import { type TableShape, tableShapeAt } from "@tasfer/table";
import type { AppEditor } from "../editorSchema";

/** The table the caret sits in, or `null` when it is somewhere else. */
export function tableContextForCaret(editor: AppEditor): TableShape | null {
  const point = editor.state.contentSelection?.focus;
  if (!point) return null;
  const block = editor.query.block({ block: point.blockId });
  if (block?.type !== "table") return null;
  const document = editor.query.content(block.id, point.contentId);
  return (document ? tableShapeAt(document, point) : undefined) ?? null;
}

/**
 * Whether the table's menu is open, shared between the editor host and the
 * overlay the engine positions on the canvas.
 *
 * Host state rather than the engine's `activeMenu`: the popover owns its own
 * lifecycle (an outside press dismisses it — see `TableTools`, which has to do
 * that itself over the canvas) and the desktop context menu re-opens it, so the
 * engine's menu state has nothing to say about it. What the host does own is
 * closing it when the caret leaves the grid — the commands would have no target
 * there.
 */
export const TableToolsContext = createContext<{
  open: boolean;
  setOpen: (open: boolean) => void;
}>({ open: false, setOpen: () => {} });

export function useTableTools() {
  return useContext(TableToolsContext);
}

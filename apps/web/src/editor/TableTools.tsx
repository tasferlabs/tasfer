import * as Popover from "@radix-ui/react-popover";
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  ArrowDownToLine,
  ArrowLeftToLine,
  ArrowRightToLine,
  ArrowUpToLine,
  Check,
  Table2,
  Trash2,
} from "lucide-react";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TableAlign, TableInsertSide, TableShape } from "@tasfer/table";
import { cn } from "@/lib/utils";

interface TableToolsProps {
  /** The grid at the caret — the source of truth for every control's state. */
  shape: TableShape;
  /** The active cell's box, in the overlay layer's coordinates. */
  anchor: { x: number; y: number; width: number; height: number };
  /** The whole grid's box, so the grip can stay over the table. */
  grid: { x: number; y: number; width: number; height: number };
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInsertRow: (side: TableInsertSide) => void;
  onDeleteRow: () => void;
  onInsertColumn: (side: TableInsertSide) => void;
  onDeleteColumn: () => void;
  onAlign: (align: TableAlign | null) => void;
  /** Portal target for the menu — the editor's own overlay container. */
  container?: HTMLElement | null;
}

/** One command row in the menu. */
interface TableToolsRow {
  id: string;
  label: string;
  icon: React.ReactNode;
  onSelect: () => void;
  /** Marks the alignment the column already has — rendered with a check. */
  active?: boolean;
  destructive?: boolean;
}

/**
 * The table's structural controls, reached from a grip beside the cell the
 * caret is in.
 *
 * This replaces a dialog, and the reason is the same one that shaped the
 * commands themselves: every one of them is relative to the current cell. A
 * dialog made the user leave that cell to act on it, and gave back no view of
 * what they were about to change. The grip sits on the grid, follows the caret
 * from cell to cell, and never takes focus — it and every row suppress
 * `mousedown`, so the caret stays where it is and the commands keep their
 * target.
 *
 * The commands read as a menu rather than a strip of glyphs: they are named
 * operations ("Add row above", "Align center"), and a row of unlabeled arrows
 * asked the user to decode which arrow meant which axis. So the grip opens the
 * same popover shell the canvas context menu uses — same rows, same check-marked
 * state — and only the way in differs. That includes how it goes away: a press
 * outside dismisses it, wherever it lands. A press on another cell still moves
 * the caret there (the menu never swallows it), so the grip is waiting in the
 * new cell, one click from the same commands.
 *
 * On a phone this surface is not rendered at all: the keyboard toolbar carries
 * the identical command set in a panel above the bar, where a thumb can reach it
 * (see the table menu in `mobileToolbar.ts`).
 */
export function TableTools({
  shape,
  anchor,
  grid,
  open,
  onOpenChange,
  onInsertRow,
  onDeleteRow,
  onInsertColumn,
  onDeleteColumn,
  onAlign,
  container,
}: TableToolsProps) {
  const { t } = useTranslation();
  const gripRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState({ left: anchor.x, top: anchor.y });

  // Dismissal over the canvas, which Radix cannot do for us. It defers an
  // outside press to that press's `click`, and the editor's focus hack fires a
  // synthetic click on its hidden input *during* the canvas `mousedown` — which
  // Radix reads as an intercepted interaction and then skips the dismissal
  // (`handleMouseDown` closes the context menu by hand for the same reason).
  // Presses that leave the grid were closing this menu anyway, but only because
  // the host tears it down when the caret leaves the table; a press on a sibling
  // cell keeps the caret in the grid, so the menu just followed the caret to its
  // new cell instead of going away. Close it here, in the capture phase, ahead
  // of the focus hack. Nothing is prevented, so the press still lands its caret.
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (gripRef.current?.contains(target)) return;
      if (contentRef.current?.contains(target)) return;
      onOpenChange(false);
    };
    document.addEventListener("mousedown", dismiss, true);
    return () => document.removeEventListener("mousedown", dismiss, true);
  }, [open, onOpenChange]);

  // The host renders this inside a box already positioned at the active cell, so
  // these offsets are relative to that cell, not the page.
  //
  // Sit above the cell, and stay inside the grid horizontally — beside a cell in
  // the last column the grip would otherwise hang off the table's edge.
  useLayoutEffect(() => {
    const width = gripRef.current?.offsetWidth ?? 0;
    const height = gripRef.current?.offsetHeight ?? 0;
    const GAP = 6;
    const gridLeft = grid.x - anchor.x;
    const gridRight = gridLeft + grid.width;
    const left = Math.min(
      Math.max(gridLeft, 0),
      Math.max(gridLeft, gridRight - width),
    );
    // Above the cell, unless the table's top row is where the caret is and the
    // grip would leave the document — then below it, the flip a tooltip makes.
    const above = -(height + GAP);
    const room = anchor.y + above >= 0;
    setOffset({ left, top: room ? above : anchor.height + GAP });
  }, [anchor.x, anchor.y, anchor.height, grid.x, grid.width]);

  /** Never surrender the caret: the commands act on the cell it is in. */
  const hold = (event: React.MouseEvent) => event.preventDefault();

  // A command that cannot run is left out rather than greyed out — the rule the
  // canvas context menu already follows. Only the deletes can be impossible: a
  // table's last row and last column have nothing to fall back to.
  const rowCommands: TableToolsRow[] = [
    {
      id: "row-above",
      label: t("editor.table.addRowAbove", "Add row above"),
      icon: <ArrowUpToLine className="size-4" />,
      onSelect: () => onInsertRow("before"),
    },
    {
      id: "row-below",
      label: t("editor.table.addRowBelow", "Add row below"),
      icon: <ArrowDownToLine className="size-4" />,
      onSelect: () => onInsertRow("after"),
    },
    ...(shape.rows > 1
      ? [
          {
            id: "row-delete",
            label: t("editor.table.removeRow", "Remove row"),
            icon: <Trash2 className="size-4" />,
            onSelect: onDeleteRow,
            destructive: true,
          },
        ]
      : []),
  ];

  const columnCommands: TableToolsRow[] = [
    {
      id: "column-before",
      label: t("editor.table.addColumnBefore", "Add column before"),
      icon: <ArrowLeftToLine className="size-4" />,
      onSelect: () => onInsertColumn("before"),
    },
    {
      id: "column-after",
      label: t("editor.table.addColumnAfter", "Add column after"),
      icon: <ArrowRightToLine className="size-4" />,
      onSelect: () => onInsertColumn("after"),
    },
    ...(shape.columns > 1
      ? [
          {
            id: "column-delete",
            label: t("editor.table.removeColumn", "Remove column"),
            icon: <Trash2 className="size-4" />,
            onSelect: onDeleteColumn,
            destructive: true,
          },
        ]
      : []),
  ];

  const alignCommands: TableToolsRow[] = [
    {
      id: "align-default",
      label: t("editor.table.alignDefault", "Default alignment"),
      icon: <AlignJustify className="size-4" />,
      onSelect: () => onAlign(null),
      active: shape.align === null,
    },
    {
      id: "align-left",
      label: t("editor.table.alignLeft", "Align left"),
      icon: <AlignLeft className="size-4" />,
      onSelect: () => onAlign("left"),
      active: shape.align === "left",
    },
    {
      id: "align-center",
      label: t("editor.table.alignCenter", "Align center"),
      icon: <AlignCenter className="size-4" />,
      onSelect: () => onAlign("center"),
      active: shape.align === "center",
    },
    {
      id: "align-right",
      label: t("editor.table.alignRight", "Align right"),
      icon: <AlignRight className="size-4" />,
      onSelect: () => onAlign("right"),
      active: shape.align === "right",
    },
  ];

  return (
    <div
      ref={gripRef}
      className="absolute z-10"
      style={{ left: offset.left, top: offset.top, pointerEvents: "auto" }}
    >
      <Popover.Root open={open} onOpenChange={onOpenChange}>
        <Popover.Trigger asChild>
          <button
            type="button"
            onMouseDown={hold}
            aria-label={t("editor.table.tools", "Table tools")}
            title={t("editor.table.tools", "Table tools")}
            className={cn(
              "flex size-6 items-center justify-center rounded-md border border-border bg-popover shadow-sm",
              open
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Table2 className="size-3.5" />
          </button>
        </Popover.Trigger>
        <Popover.Portal container={container}>
          <Popover.Content
            ref={contentRef}
            className="bg-popover/95 backdrop-blur-xl rounded-xl border border-border/60 p-1.5 min-w-[200px] z-50 select-none pointer-events-auto animate-in fade-in zoom-in-95 duration-100"
            style={{
              boxShadow:
                "0 0 0 0.5px rgba(0,0,0,0.03), 0 2px 4px rgba(0,0,0,0.04), 0 8px 24px rgba(0,0,0,0.1), 0 24px 48px rgba(0,0,0,0.06)",
            }}
            side="top"
            align="start"
            sideOffset={6}
            collisionBoundary={container}
            collisionPadding={10}
            // Focus stays on the editor's hidden input: the commands act on the
            // caret's cell, and the user keeps typing into it with the menu up.
            onOpenAutoFocus={(event) => event.preventDefault()}
            onCloseAutoFocus={(event) => event.preventDefault()}
            onMouseDown={hold}
          >
            <Rows rows={rowCommands} />
            <Separator />
            <Rows rows={columnCommands} />
            <Separator />
            <Rows rows={alignCommands} />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}

function Separator() {
  return <div aria-hidden className="my-1 h-px bg-border/60" />;
}

/**
 * A group of command rows. The menu stays open after each one: these commands
 * come in runs — three rows, then align the column — and every row re-reads the
 * grid's live shape, so the check mark and the deletes follow each edit.
 */
function Rows({ rows }: { rows: TableToolsRow[] }) {
  return (
    <>
      {rows.map((row) => (
        <button
          key={row.id}
          type="button"
          onClick={row.onSelect}
          aria-pressed={row.active}
          className={cn(
            "group w-full px-2.5 py-[7px] flex items-center gap-2.5 rounded-[9px] text-[13px] font-medium transition-all duration-75",
            "hover:bg-accent hover:text-accent-foreground active:bg-accent/80 active:scale-[0.98]",
            row.active ? "text-primary" : "text-popover-foreground",
            row.destructive && "hover:bg-destructive/10 hover:text-destructive",
          )}
        >
          {/* The icon sits a shade back from its label, but takes the row's own
              colour on hover so a destructive row goes red as one piece. */}
          <span
            className={cn(
              "w-4 h-4 flex items-center justify-center shrink-0",
              row.active
                ? "text-primary"
                : "text-muted-foreground group-hover:text-inherit",
            )}
          >
            {row.icon}
          </span>
          <span className="flex-1 text-start">{row.label}</span>
          {row.active && <Check size={13} className="text-primary" />}
        </button>
      ))}
    </>
  );
}

import React, { useCallback, useEffect, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronRight } from "lucide-react";
import { triggerHaptic } from "@/platform/bridge";

export interface ContextMenuItem {
  id: string;
  label: string;
  icon: React.ReactNode;
  action?: () => void;
  disabled?: boolean;
  active?: boolean;
  children?: ContextMenuItem[];
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
  collisionBoundary?: HTMLElement | null;
  container?: HTMLElement | null;
  hoveredItemId?: string | null;
}

interface SubmenuProps {
  item: ContextMenuItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  highlighted: boolean;
  /** Child row the keyboard is on, or null when the pointer is driving. */
  activeChildId: string | null;
  onClose: () => void;
  collisionBoundary?: HTMLElement | null;
  container?: HTMLElement | null;
  rtl: boolean;
}

/** The rows a user can actually land on — disabled items are never painted. */
function enabledRows(items: ContextMenuItem[] | undefined): ContextMenuItem[] {
  return (items ?? []).filter((item) => !item.disabled);
}

const Submenu: React.FC<SubmenuProps> = ({
  item,
  open,
  onOpenChange,
  highlighted,
  activeChildId,
  onClose,
  collisionBoundary,
  container,
  rtl,
}) => {
  if (!item.children || item.children.length === 0) {
    return null;
  }

  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>
        <button
          data-context-menu-item-id={item.id}
          className={`w-full px-2.5 py-[7px] flex items-center gap-2.5 rounded-[9px] text-[13px] font-medium transition-all duration-75 ${
            item.disabled
              ? "opacity-50 cursor-not-allowed text-muted-foreground"
              : open || highlighted
              ? "bg-accent text-accent-foreground"
              : "text-popover-foreground hover:bg-accent hover:text-accent-foreground active:bg-accent/80 active:scale-[0.98]"
          }`}
          onMouseDown={(e) => {
            e.preventDefault();
          }}
          disabled={item.disabled}
        >
          <span className="w-4 h-4 flex items-center justify-center shrink-0 text-muted-foreground">
            {item.icon}
          </span>
          <span className="flex-1 text-start">{item.label}</span>
          <ChevronRight size={13} className="text-muted-foreground/70 rtl:rotate-180" />
        </button>
      </Popover.Trigger>
      <Popover.Portal container={container}>
        <Popover.Content
          className="bg-popover/95 backdrop-blur-xl rounded-xl border border-border/60 p-1.5 min-w-[170px] z-[51] select-none pointer-events-auto animate-in fade-in zoom-in-95 duration-100"
          style={{ boxShadow: "0 0 0 0.5px rgba(0,0,0,0.03), 0 2px 4px rgba(0,0,0,0.04), 0 8px 24px rgba(0,0,0,0.1), 0 24px 48px rgba(0,0,0,0.06)" }}
          side={rtl ? "left" : "right"}
          align="start"
          sideOffset={4}
          alignOffset={-4}
          collisionBoundary={collisionBoundary}
          collisionPadding={10}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          {item.children.map((child) => {
            if (child.disabled) {
              return null;
            }
            const isActive = activeChildId === child.id;
            return (
              <button
                key={child.id}
                data-context-menu-item-id={child.id}
                className={`text-start w-full px-2.5 py-[7px] flex items-center gap-2.5 rounded-[9px] text-[13px] font-medium transition-all duration-75 hover:bg-accent hover:text-accent-foreground active:bg-accent/80 active:scale-[0.98] ${
                  isActive ? "bg-accent" : ""
                } ${
                  child.active
                    ? "text-primary"
                    : isActive
                    ? "text-accent-foreground"
                    : "text-popover-foreground"
                }`}
                onClick={() => {
                  if (!child.disabled && child.action) {
                    child.action();
                    onClose();
                  }
                }}
                onMouseDown={(e) => {
                  e.preventDefault();
                }}
                disabled={child.disabled}
              >
                <span className={`w-4 h-4 flex items-center justify-center shrink-0 ${
                  child.active ? "text-primary" : "text-muted-foreground"
                }`}>
                  {child.icon}
                </span>
                <span className="flex-1">{child.label}</span>
                {child.active && (
                  <Check size={13} className="text-primary" />
                )}
              </button>
            );
          })}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
};

export const ContextMenu: React.FC<ContextMenuProps> = ({
  x,
  y,
  items,
  onClose,
  collisionBoundary,
  container,
  hoveredItemId,
}) => {
  // Keyboard row, independent of the pointer hover the engine forwards during a
  // long-press drag. -1 until the first arrow, so an opened menu highlights
  // nothing — same as a native one.
  const [activeIndex, setActiveIndex] = useState(-1);
  // The open submenu and the child row inside it, when the keyboard opened it.
  const [openSubmenu, setOpenSubmenu] = useState<{
    id: string;
    index: number;
  } | null>(null);

  const rows = enabledRows(items);
  const rtl =
    typeof document !== "undefined" && document.documentElement.dir === "rtl";

  useEffect(() => {
    triggerHaptic("medium");
  }, []);

  // Refs so the once-registered keydown handler always reads the latest values.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const activeIndexRef = useRef(activeIndex);
  activeIndexRef.current = activeIndex;
  const openSubmenuRef = useRef(openSubmenu);
  openSubmenuRef.current = openSubmenu;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const submenuRows = useCallback(
    (id: string): ContextMenuItem[] =>
      enabledRows(rowsRef.current.find((row) => row.id === id)?.children),
    [],
  );

  // Step the highlight, wrapping at both ends. From "nothing highlighted" a
  // downward step lands on the first row and an upward one on the last.
  const move = useCallback(
    (delta: number) => {
      const submenu = openSubmenuRef.current;
      if (submenu) {
        const children = submenuRows(submenu.id);
        if (children.length === 0) return;
        setOpenSubmenu({
          id: submenu.id,
          index: (submenu.index + delta + children.length) % children.length,
        });
        return;
      }
      const count = rowsRef.current.length;
      if (count === 0) return;
      setActiveIndex((index) =>
        index < 0
          ? delta > 0
            ? 0
            : count - 1
          : (index + delta + count) % count,
      );
    },
    [submenuRows],
  );

  // Jump to the first or last row of whichever level the keyboard is on.
  const jump = useCallback(
    (edge: "first" | "last") => {
      const submenu = openSubmenuRef.current;
      if (submenu) {
        const children = submenuRows(submenu.id);
        if (children.length === 0) return;
        setOpenSubmenu({
          id: submenu.id,
          index: edge === "first" ? 0 : children.length - 1,
        });
        return;
      }
      const count = rowsRef.current.length;
      if (count === 0) return;
      setActiveIndex(edge === "first" ? 0 : count - 1);
    },
    [submenuRows],
  );

  const activate = useCallback(() => {
    const submenu = openSubmenuRef.current;
    if (submenu) {
      const child = submenuRows(submenu.id)[submenu.index];
      if (!child?.action) return;
      child.action();
      onCloseRef.current();
      return;
    }
    const row = rowsRef.current[activeIndexRef.current];
    if (!row) return;
    if (enabledRows(row.children).length > 0) {
      setOpenSubmenu({ id: row.id, index: 0 });
      return;
    }
    if (!row.action) return;
    row.action();
    onCloseRef.current();
  }, [submenuRows]);

  // Capture-phase keydown on window — fires before the engine's keydown handler
  // (bound on its hidden input element), so the menu claims the keys it needs
  // while the caret stays put behind it. Everything else falls through to the
  // editor, so ⌘C and friends still act on the selection the menu is about.
  useEffect(() => {
    const forward = rtl ? "ArrowLeft" : "ArrowRight";
    const back = rtl ? "ArrowRight" : "ArrowLeft";

    const onKeyDown = (e: KeyboardEvent) => {
      const claim = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      switch (e.key) {
        case "ArrowDown":
          claim();
          move(1);
          break;
        case "ArrowUp":
          claim();
          move(-1);
          break;
        case "Tab":
          claim();
          move(e.shiftKey ? -1 : 1);
          break;
        case "Home":
          claim();
          jump("first");
          break;
        case "End":
          claim();
          jump("last");
          break;
        case forward: {
          claim();
          const row = rowsRef.current[activeIndexRef.current];
          if (row && enabledRows(row.children).length > 0) {
            setOpenSubmenu({ id: row.id, index: 0 });
          }
          break;
        }
        case back:
          claim();
          setOpenSubmenu(null);
          break;
        case "Enter":
          claim();
          activate();
          break;
        case "Escape":
          claim();
          // Escape backs out one level: an open submenu first, then the menu.
          if (openSubmenuRef.current) setOpenSubmenu(null);
          else onCloseRef.current();
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [activate, jump, move, rtl]);

  if (items.length === 0) {
    return null;
  }

  const keyboardItemId =
    activeIndex >= 0 ? (rows[activeIndex]?.id ?? null) : null;
  // The keyboard owns the highlight once it has one; otherwise the long-press
  // drag hover the engine forwards does.
  const highlightedId = keyboardItemId ?? hoveredItemId ?? null;

  return (
    <Popover.Root open={true} onOpenChange={(open) => !open && onClose()}>
      <Popover.Anchor
        style={{
          position: "fixed",
          left: `${x}px`,
          top: `${y}px`,
          width: 1,
          height: 1,
        }}
      />
      <Popover.Portal container={container}>
        <Popover.Content
          className="bg-popover/95 backdrop-blur-xl rounded-xl border border-border/60 p-1.5 min-w-[170px] z-50 select-none pointer-events-auto animate-in fade-in zoom-in-95 duration-100"
          style={{ boxShadow: "0 0 0 0.5px rgba(0,0,0,0.03), 0 2px 4px rgba(0,0,0,0.04), 0 8px 24px rgba(0,0,0,0.1), 0 24px 48px rgba(0,0,0,0.06)" }}
          side="top"
          align="start"
          sideOffset={5}
          collisionBoundary={collisionBoundary}
          collisionPadding={10}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          // A moving pointer takes the highlight back, so a keyboard row and a
          // hovered row never both look selected. Re-render only on the first
          // move after an arrow key (React bails on an unchanged -1).
          onMouseMove={() => setActiveIndex((index) => (index < 0 ? index : -1))}
        >
          {items.map((item) => {
            const isHighlighted = highlightedId === item.id;
            if (item.disabled) {
              return null;
            }

            // Render submenu if item has children
            if (item.children && item.children.length > 0) {
              const submenu = openSubmenu?.id === item.id ? openSubmenu : null;
              return (
                <Submenu
                  key={item.id}
                  item={item}
                  open={!!submenu}
                  onOpenChange={(open) =>
                    setOpenSubmenu(open ? { id: item.id, index: 0 } : null)
                  }
                  highlighted={isHighlighted}
                  activeChildId={
                    submenu
                      ? (enabledRows(item.children)[submenu.index]?.id ?? null)
                      : null
                  }
                  onClose={onClose}
                  collisionBoundary={collisionBoundary}
                  container={container}
                  rtl={rtl}
                />
              );
            }

            return (
              <button
                key={item.id}
                data-context-menu-item-id={item.id}
                className={`w-full px-2.5 py-[7px] flex items-center gap-2.5 rounded-[9px] text-[13px] font-medium transition-all duration-75 ${
                  item.disabled
                    ? "opacity-50 cursor-not-allowed text-muted-foreground"
                    : isHighlighted
                    ? "bg-accent text-accent-foreground"
                    : "text-popover-foreground hover:bg-accent hover:text-accent-foreground active:bg-accent/80 active:scale-[0.98]"
                }`}
                onClick={() => {
                  if (!item.disabled && item.action) {
                    item.action();
                    onClose();
                  }
                }}
                onMouseDown={(e) => {
                  // Prevent button from taking focus away from hidden input
                  e.preventDefault();
                }}
                disabled={item.disabled}
              >
                <span className="w-4 h-4 flex items-center justify-center shrink-0 text-muted-foreground">
                  {item.icon}
                </span>
                <span>{item.label}</span>
              </button>
            );
          })}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
};

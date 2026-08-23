import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  activeChildId: string | null;
  onActivateChild: (id: string | null) => void;
  onClose: () => void;
  isActive: boolean;
  onHover: () => void;
  collisionBoundary?: HTMLElement | null;
  container?: HTMLElement | null;
}

/** Disabled entries are never rendered, so this is also what the keyboard walks. */
const visibleItems = (items: ContextMenuItem[]) =>
  items.filter((item) => !item.disabled);

const isRtl = () =>
  typeof document !== "undefined" && document.documentElement.dir === "rtl";

/** How long a type-select prefix stays live between keystrokes. */
const TYPE_AHEAD_RESET_MS = 1000;

const Submenu: React.FC<SubmenuProps> = ({
  item,
  isOpen,
  onOpenChange,
  activeChildId,
  onActivateChild,
  onClose,
  isActive,
  onHover,
  collisionBoundary,
  container,
}) => {
  const children = visibleItems(item.children ?? []);

  if (children.length === 0) {
    return null;
  }

  return (
    <Popover.Root open={isOpen} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>
        <button
          data-context-menu-item-id={item.id}
          className={`w-full px-2.5 py-[7px] flex items-center gap-2.5 rounded-[9px] text-[13px] font-medium transition-all duration-75 ${
            item.disabled
              ? "opacity-50 cursor-not-allowed text-muted-foreground"
              : isOpen || isActive
              ? "bg-accent text-accent-foreground"
              : "text-popover-foreground hover:bg-accent hover:text-accent-foreground active:bg-accent/80 active:scale-[0.98]"
          }`}
          onMouseEnter={onHover}
          onMouseDown={(e) => {
            e.preventDefault();
          }}
          disabled={item.disabled}
        >
          <span className="w-4 h-4 flex items-center justify-center shrink-0 text-muted-foreground">
            {item.icon}
          </span>
          <span className="flex-1 text-start">{item.label}</span>
          <ChevronRight size={13} className="text-muted-foreground/70 rtl:-scale-x-100" />
        </button>
      </Popover.Trigger>
      <Popover.Portal container={container}>
        <Popover.Content
          className="bg-popover/95 backdrop-blur-xl rounded-xl border border-border/60 p-1.5 min-w-[170px] z-[51] select-none pointer-events-auto animate-in fade-in zoom-in-95 duration-100"
          style={{ boxShadow: "0 0 0 0.5px rgba(0,0,0,0.03), 0 2px 4px rgba(0,0,0,0.04), 0 8px 24px rgba(0,0,0,0.1), 0 24px 48px rgba(0,0,0,0.06)" }}
          side={isRtl() ? "left" : "right"}
          align="start"
          sideOffset={4}
          alignOffset={-4}
          collisionBoundary={collisionBoundary}
          collisionPadding={10}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          {children.map((child) => (
            <button
              key={child.id}
              data-context-menu-item-id={child.id}
              className={`text-start w-full px-2.5 py-[7px] flex items-center gap-2.5 rounded-[9px] text-[13px] font-medium transition-all duration-75 active:bg-accent/80 active:scale-[0.98] ${
                activeChildId === child.id
                  ? "bg-accent text-accent-foreground"
                  : "hover:bg-accent hover:text-accent-foreground"
              } ${child.active ? "text-primary" : "text-popover-foreground"}`}
              onClick={() => {
                if (child.action) {
                  child.action();
                  onClose();
                }
              }}
              onMouseEnter={() => onActivateChild(child.id)}
              onMouseDown={(e) => {
                e.preventDefault();
              }}
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
          ))}
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
  // Keyboard highlight. Focus deliberately stays on the editor's hidden input —
  // the menu's actions (copy, formatting) act on the live editor selection — so
  // the menu can't be walked by focus. It tracks its own active row instead and
  // reads keys off a capture-phase document listener, the way a native menu
  // grabs the keyboard while it is up. The engine swallows keys meanwhile
  // (`hostMenuCapturing`), so nothing types into the document behind it.
  const [activeId, setActiveId] = useState<string | null>(null);
  const [openSubmenuId, setOpenSubmenuId] = useState<string | null>(null);
  const [activeChildId, setActiveChildId] = useState<string | null>(null);

  // Type-select prefix ("cu" jumps to Cut), held in a ref so accumulating it
  // doesn't re-render the menu — only the row it lands on does.
  const typeAheadRef = useRef<{ prefix: string; timer: number | null }>({
    prefix: "",
    timer: null,
  });

  const resetTypeAhead = useCallback(() => {
    const typeAhead = typeAheadRef.current;
    if (typeAhead.timer !== null) window.clearTimeout(typeAhead.timer);
    typeAhead.timer = null;
    typeAhead.prefix = "";
  }, []);

  // Drop a pending lapse timer when the menu goes away.
  useEffect(() => resetTypeAhead, [resetTypeAhead]);

  const rows = useMemo(() => visibleItems(items), [items]);

  useEffect(() => {
    triggerHaptic("medium");
  }, []);

  const closeSubmenu = useCallback(() => {
    setOpenSubmenuId(null);
    setActiveChildId(null);
  }, []);

  const openSubmenu = useCallback((item: ContextMenuItem) => {
    const children = visibleItems(item.children ?? []);
    if (children.length === 0) return false;
    setOpenSubmenuId(item.id);
    setActiveChildId(children[0].id);
    return true;
  }, []);

  useEffect(() => {
    if (rows.length === 0) return;

    const step = (
      list: ContextMenuItem[],
      current: string | null,
      delta: number,
    ) => {
      const index = list.findIndex((entry) => entry.id === current);
      if (index === -1) return delta > 0 ? list[0] : list[list.length - 1];
      return list[(index + delta + list.length) % list.length];
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const openItem = openSubmenuId
        ? rows.find((item) => item.id === openSubmenuId)
        : undefined;
      const children = visibleItems(openItem?.children ?? []);
      const inSubmenu = children.length > 0;
      // In RTL the submenu opens on the left, so the chord that dives into it
      // flips with it.
      const diveKey = isRtl() ? "ArrowLeft" : "ArrowRight";
      const backKey = isRtl() ? "ArrowRight" : "ArrowLeft";

      const handled = () => {
        event.preventDefault();
        event.stopPropagation();
      };

      // Type-select, as a native menu does: the typed prefix jumps to the first
      // row whose label starts with it, and lapses after a pause. A bare space
      // still invokes; once a prefix is live it belongs to the search instead,
      // so multi-word labels ("Select All") stay reachable.
      const isTypeSelect =
        event.key.length === 1 &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        (event.key !== " " || typeAheadRef.current.prefix.length > 0);

      if (isTypeSelect) {
        handled();
        const typeAhead = typeAheadRef.current;
        if (typeAhead.timer !== null) window.clearTimeout(typeAhead.timer);
        typeAhead.timer = window.setTimeout(resetTypeAhead, TYPE_AHEAD_RESET_MS);
        typeAhead.prefix += event.key;

        const prefix = typeAhead.prefix.toLocaleLowerCase();
        const list = inSubmenu ? children : rows;
        const match = list.find((entry) =>
          entry.label.toLocaleLowerCase().startsWith(prefix),
        );
        if (match) {
          if (inSubmenu) setActiveChildId(match.id);
          else setActiveId(match.id);
        }
        return;
      }

      // Anything else ends the search — the next character starts a fresh one.
      resetTypeAhead();

      switch (event.key) {
        case "ArrowDown":
        case "ArrowUp": {
          handled();
          const delta = event.key === "ArrowDown" ? 1 : -1;
          if (inSubmenu) {
            setActiveChildId(step(children, activeChildId, delta).id);
          } else {
            setActiveId(step(rows, activeId, delta).id);
          }
          return;
        }
        case "Home":
        case "End": {
          handled();
          const list = inSubmenu ? children : rows;
          const target = event.key === "Home" ? list[0] : list[list.length - 1];
          if (inSubmenu) setActiveChildId(target.id);
          else setActiveId(target.id);
          return;
        }
        case diveKey: {
          if (inSubmenu) return;
          const item = rows.find((entry) => entry.id === activeId);
          if (item && openSubmenu(item)) handled();
          return;
        }
        case backKey: {
          if (!inSubmenu) return;
          handled();
          closeSubmenu();
          return;
        }
        case "Enter":
        case " ": {
          handled();
          if (inSubmenu) {
            const child = children.find((entry) => entry.id === activeChildId);
            child?.action?.();
            if (child) onClose();
            return;
          }
          const item = rows.find((entry) => entry.id === activeId);
          if (!item) return;
          if (openSubmenu(item)) return;
          item.action?.();
          onClose();
          return;
        }
        case "Escape": {
          handled();
          if (inSubmenu) closeSubmenu();
          else onClose();
          return;
        }
        case "Tab": {
          handled();
          onClose();
          return;
        }
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [
    rows,
    activeId,
    activeChildId,
    openSubmenuId,
    openSubmenu,
    closeSubmenu,
    resetTypeAhead,
    onClose,
  ]);

  if (rows.length === 0) {
    return null;
  }

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
        >
          {rows.map((item) => {
            // The touch long-press drag reports its own hover; the keyboard
            // highlight is the same row state, so either source lights a row.
            const isActive = hoveredItemId === item.id || activeId === item.id;

            if (item.children && item.children.length > 0) {
              return (
                <Submenu
                  key={item.id}
                  item={item}
                  isOpen={openSubmenuId === item.id}
                  onOpenChange={(open) => {
                    // Pointer-opened: highlight the trigger row but preselect no
                    // child — the keyboard path (openSubmenu) is what lands on
                    // the first one.
                    setActiveId(item.id);
                    setActiveChildId(null);
                    setOpenSubmenuId(open ? item.id : null);
                  }}
                  activeChildId={activeChildId}
                  onActivateChild={setActiveChildId}
                  onClose={onClose}
                  isActive={isActive}
                  onHover={() => {
                    setActiveId(item.id);
                    if (openSubmenuId !== item.id) closeSubmenu();
                  }}
                  collisionBoundary={collisionBoundary}
                  container={container}
                />
              );
            }

            return (
              <button
                key={item.id}
                data-context-menu-item-id={item.id}
                className={`w-full px-2.5 py-[7px] flex items-center gap-2.5 rounded-[9px] text-[13px] font-medium transition-all duration-75 ${
                  isActive
                    ? "bg-accent text-accent-foreground"
                    : "text-popover-foreground hover:bg-accent hover:text-accent-foreground active:bg-accent/80 active:scale-[0.98]"
                }`}
                onClick={() => {
                  if (item.action) {
                    item.action();
                    onClose();
                  }
                }}
                onMouseEnter={() => {
                  setActiveId(item.id);
                  closeSubmenu();
                }}
                onMouseDown={(e) => {
                  // Prevent button from taking focus away from hidden input
                  e.preventDefault();
                }}
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

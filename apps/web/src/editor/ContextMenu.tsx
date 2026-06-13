import React, { useEffect, useState } from "react";
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
  onClose: () => void;
  collisionBoundary?: HTMLElement | null;
  container?: HTMLElement | null;
}

const Submenu: React.FC<SubmenuProps> = ({
  item,
  onClose,
  collisionBoundary,
  container,
}) => {
  const [isOpen, setIsOpen] = useState(false);

  if (!item.children || item.children.length === 0) {
    return null;
  }

  return (
    <Popover.Root open={isOpen} onOpenChange={setIsOpen}>
      <Popover.Trigger asChild>
        <button
          data-context-menu-item-id={item.id}
          className={`w-full px-2.5 py-[7px] flex items-center gap-2.5 rounded-[9px] text-[13px] font-medium transition-all duration-75 ${
            item.disabled
              ? "opacity-50 cursor-not-allowed text-muted-foreground"
              : isOpen
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
          <ChevronRight size={13} className="text-muted-foreground/70" />
        </button>
      </Popover.Trigger>
      <Popover.Portal container={container}>
        <Popover.Content
          className="bg-popover/95 backdrop-blur-xl rounded-xl border border-border/60 p-1.5 min-w-[170px] z-[51] select-none pointer-events-auto animate-in fade-in zoom-in-95 duration-100"
          style={{ boxShadow: "0 0 0 0.5px rgba(0,0,0,0.03), 0 2px 4px rgba(0,0,0,0.04), 0 8px 24px rgba(0,0,0,0.1), 0 24px 48px rgba(0,0,0,0.06)" }}
          side="right"
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
            return (
              <button
                key={child.id}
                data-context-menu-item-id={child.id}
                className={`text-start w-full px-2.5 py-[7px] flex items-center gap-2.5 rounded-[9px] text-[13px] font-medium transition-all duration-75 hover:bg-accent hover:text-accent-foreground active:bg-accent/80 active:scale-[0.98] ${
                  child.active
                    ? "text-primary"
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
  useEffect(() => {
    triggerHaptic("medium");
  }, []);

  if (items.length === 0) {
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
          {items.map((item) => {
            const isHovered = hoveredItemId === item.id;
            if (item.disabled) {
              return null;
            }

            // Render submenu if item has children
            if (item.children && item.children.length > 0) {
              return (
                <Submenu
                  key={item.id}
                  item={item}
                  onClose={onClose}
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
                  item.disabled
                    ? "opacity-50 cursor-not-allowed text-muted-foreground"
                    : isHovered
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

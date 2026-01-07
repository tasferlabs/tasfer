import React from "react";
import * as Popover from "@radix-ui/react-popover";

export interface ContextMenuItem {
  id: string;
  label: string;
  icon: React.ReactNode;
  action: () => void;
  disabled?: boolean;
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

export const ContextMenu: React.FC<ContextMenuProps> = ({
  x,
  y,
  items,
  onClose,
  collisionBoundary,
  container,
  hoveredItemId,
}) => {
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
          className="bg-popover rounded-xl shadow-lg border border-border p-1 min-w-[160px] z-50 select-none pointer-events-auto animate-in fade-in zoom-in-95 duration-100"
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
            return (
              <button
                key={item.id}
                data-context-menu-item-id={item.id}
                className={`w-full px-2 py-2 flex items-center gap-2.5 rounded-lg text-sm font-medium transition-colors ${
                  item.disabled
                    ? "opacity-50 cursor-not-allowed text-muted-foreground"
                    : isHovered
                    ? "bg-accent text-accent-foreground"
                    : "text-popover-foreground hover:bg-accent hover:text-accent-foreground active:bg-accent/80"
                }`}
                onClick={() => {
                  if (!item.disabled) {
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

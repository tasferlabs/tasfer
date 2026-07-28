import * as React from "react";
import { ContextMenu as ContextMenuPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

function ContextMenu({
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Root>) {
  return <ContextMenuPrimitive.Root data-slot="context-menu" {...props} />;
}

function ContextMenuTrigger({
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Trigger>) {
  return (
    <ContextMenuPrimitive.Trigger
      data-slot="context-menu-trigger"
      {...props}
    />
  );
}

function ContextMenuContent({
  className,
  onEscapeKeyDown,
  onPointerDown,
  onPointerUp,
  onMouseDown,
  onMouseUp,
  onClick,
  onTouchStart,
  onTouchEnd,
  onContextMenu,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Content>) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content
        data-slot="context-menu-content"
        onEscapeKeyDown={(event) => {
          onEscapeKeyDown?.(event);
          event.stopPropagation();
        }}
        onPointerDown={(event) => {
          onPointerDown?.(event);
          event.stopPropagation();
        }}
        onPointerUp={(event) => {
          onPointerUp?.(event);
          event.stopPropagation();
        }}
        onMouseDown={(event) => {
          onMouseDown?.(event);
          event.stopPropagation();
        }}
        onMouseUp={(event) => {
          onMouseUp?.(event);
          event.stopPropagation();
        }}
        onClick={(event) => {
          onClick?.(event);
          event.stopPropagation();
        }}
        onTouchStart={(event) => {
          onTouchStart?.(event);
          event.stopPropagation();
        }}
        onTouchEnd={(event) => {
          onTouchEnd?.(event);
          event.stopPropagation();
        }}
        onContextMenu={(event) => {
          onContextMenu?.(event);
          event.stopPropagation();
        }}
        className={cn(
          "data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 ring-foreground/10 bg-popover text-popover-foreground z-50 min-w-40 overflow-hidden rounded-md p-1 shadow-md ring-1 duration-100",
          className,
        )}
        {...props}
      />
    </ContextMenuPrimitive.Portal>
  );
}

function ContextMenuItem({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Item> & {
  variant?: "default" | "destructive";
}) {
  return (
    <ContextMenuPrimitive.Item
      data-slot="context-menu-item"
      data-variant={variant}
      className={cn(
        "focus:bg-accent focus:text-accent-foreground data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 dark:data-[variant=destructive]:focus:bg-destructive/20 data-[variant=destructive]:focus:text-destructive data-[variant=destructive]:*:[svg]:text-destructive not-data-[variant=destructive]:focus:**:text-accent-foreground relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
        className,
      )}
      {...props}
    />
  );
}

function ContextMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Separator>) {
  return (
    <ContextMenuPrimitive.Separator
      data-slot="context-menu-separator"
      className={cn("bg-border -mx-1 my-1 h-px", className)}
      {...props}
    />
  );
}

export {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
};

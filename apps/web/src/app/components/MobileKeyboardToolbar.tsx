import { cn } from "@/lib/utils";
import {
  Bold,
  ChevronDown,
  Code,
  Heading1,
  Heading2,
  Heading3,
  Image,
  Italic,
  List,
  ListChecks,
  ListOrdered,
  Minus,
  Pilcrow,
  Quote,
  Redo2,
  Slash,
  Strikethrough,
  Undo2,
  X,
} from "lucide-react";
import { useState } from "react";
import type {
  MobileToolbarAction,
  MobileToolbarIcon,
  MobileToolbarModel,
} from "../mobileToolbar";

const ICONS: Record<MobileToolbarIcon, React.ReactNode> = {
  undo: <Undo2 className="size-5" />,
  redo: <Redo2 className="size-5" />,
  bold: <Bold className="size-5" />,
  italic: <Italic className="size-5" />,
  code: <Code className="size-5" />,
  math_command: <Slash className="size-5 -scale-x-100" />,
  strikethrough: <Strikethrough className="size-5" />,
  paragraph: <Pilcrow className="size-4" />,
  heading1: <Heading1 className="size-4" />,
  heading2: <Heading2 className="size-4" />,
  heading3: <Heading3 className="size-4" />,
  quote: <Quote className="size-4" />,
  list: <List className="size-4" />,
  list_ordered: <ListOrdered className="size-4" />,
  list_todo: <ListChecks className="size-4" />,
  image: <Image className="size-4" />,
  line: <Minus className="size-4" />,
  keyboard_dismiss: <X className="size-5" />,
};

interface MobileKeyboardToolbarProps {
  model: MobileToolbarModel;
  onAction: (action: MobileToolbarAction) => void;
}

export function MobileKeyboardToolbar({
  model,
  onAction,
}: MobileKeyboardToolbarProps) {
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const openMenu = model.items.find(
    (item) => item.kind === "menu" && item.id === openMenuId,
  );

  return (
    <div
      data-editor-overlay
      className="fixed bottom-0 left-0 right-0 z-50 flex flex-col"
      style={{ bottom: `${model.bottomInset}px` }}
      onTouchStart={(e) => e.stopPropagation()}
    >
      {openMenu?.kind === "menu" && (
        <div className="flex w-full min-w-0 flex-row touch-pan-x overflow-x-auto overscroll-x-contain border-t border-border bg-background px-2 py-1.5 gap-1 no-scrollbar">
          {openMenu.options.map((option) => (
            <button
              key={option.id}
              onMouseDown={(e) => {
                // Prevent the compatibility mouse event from moving focus away
                // from the editor without cancelling Android's touch-pan
                // gesture on the horizontal scroller.
                e.preventDefault();
              }}
              onClick={(e) => {
                e.preventDefault();
                onAction(option.action);
                setOpenMenuId(null);
              }}
              className={cn(
                "flex shrink-0 flex-col items-center justify-center gap-0.5 rounded-md px-3 py-2 min-w-[52px]",
                "transition-colors",
                openMenu.selected === option.id
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground active:bg-muted",
              )}
            >
              {ICONS[option.icon]}
              <span className="text-[10px] leading-none whitespace-nowrap">
                {option.label}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Main toolbar row */}
      <div className="flex flex-row items-center border-t border-border bg-background h-12">
        {model.items.map((item) => {
          if (item.kind === "divider") return <Divider key={item.id} />;
          if (item.kind === "spacer")
            return <div key={item.id} className="flex-1" />;
          if (item.kind === "menu") {
            const open = openMenuId === item.id;
            return (
              <button
                key={item.id}
                onPointerDown={(e) => {
                  if (!e.isPrimary || e.button !== 0) return;
                  e.preventDefault();
                  setOpenMenuId(open ? null : item.id);
                }}
                onClick={(e) => {
                  if (e.detail === 0) {
                    setOpenMenuId(open ? null : item.id);
                  }
                }}
                className={cn(
                  "flex flex-row items-center gap-1 px-3 h-full transition-colors",
                  open
                    ? "text-primary"
                    : "text-muted-foreground active:bg-muted",
                )}
                aria-label={item.label}
              >
                {ICONS[item.icon]}
                <ChevronDown
                  className={cn(
                    "size-3.5 transition-transform",
                    open && "rotate-180",
                  )}
                />
              </button>
            );
          }

          return (
            <ToolbarButton
              key={item.id}
              onPress={() => onAction(item.action)}
              disabled={!item.enabled}
              active={item.active}
              aria-label={item.label}
            >
              {ICONS[item.icon]}
            </ToolbarButton>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface ToolbarButtonProps {
  onPress: () => void;
  disabled?: boolean;
  active?: boolean;
  "aria-label"?: string;
  children: React.ReactNode;
}

function ToolbarButton({
  onPress,
  disabled = false,
  active = false,
  children,
  ...rest
}: ToolbarButtonProps) {
  return (
    <button
      onPointerDown={(e) => {
        if (!e.isPrimary || e.button !== 0) return;
        // Keep toolbar controls from becoming the active element. Formatting
        // actions preserve the editor focus, while dismiss explicitly blurs the
        // hidden input without causing the viewport to jump to this button.
        e.preventDefault();
        if (!disabled) onPress();
      }}
      onClick={(e) => {
        if (e.detail === 0 && !disabled) onPress();
      }}
      disabled={disabled}
      className={cn(
        "flex items-center justify-center w-11 h-full transition-colors",
        active ? "text-primary" : "text-muted-foreground",
        disabled && "opacity-30",
        !disabled && "active:bg-muted",
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

function Divider() {
  return <div className="w-px h-6 bg-border mx-0.5 shrink-0" />;
}

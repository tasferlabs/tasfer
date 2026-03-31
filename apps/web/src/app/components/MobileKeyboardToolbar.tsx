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
  Redo2,
  Strikethrough,
  Undo2,
  X,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

export type BlockType =
  | "paragraph"
  | "heading1"
  | "heading2"
  | "heading3"
  | "bullet_list"
  | "numbered_list"
  | "todo_list"
  | "image"
  | "line";

const BLOCK_TYPES: { type: BlockType; labelKey: string; icon: React.ReactNode }[] =
  [
    { type: "paragraph", labelKey: "common.text", icon: <Pilcrow className="size-4" /> },
    {
      type: "heading1",
      labelKey: "blocks.heading1",
      icon: <Heading1 className="size-4" />,
    },
    {
      type: "heading2",
      labelKey: "blocks.heading2",
      icon: <Heading2 className="size-4" />,
    },
    {
      type: "heading3",
      labelKey: "blocks.heading3",
      icon: <Heading3 className="size-4" />,
    },
    {
      type: "bullet_list",
      labelKey: "blocks.bulletList",
      icon: <List className="size-4" />,
    },
    {
      type: "numbered_list",
      labelKey: "blocks.numberedList",
      icon: <ListOrdered className="size-4" />,
    },
    {
      type: "todo_list",
      labelKey: "blocks.todoList",
      icon: <ListChecks className="size-4" />,
    },
    {
      type: "image",
      labelKey: "blocks.image",
      icon: <Image className="size-4" />,
    },
    { type: "line", labelKey: "blocks.divider", icon: <Minus className="size-4" /> },
  ];

interface MobileKeyboardToolbarProps {
  isVisible: boolean;
  keyboardHeight: number;
  canUndo: boolean;
  canRedo: boolean;
  isBold: boolean;
  isItalic: boolean;
  isCode: boolean;
  isStrikethrough: boolean;
  currentBlockType: BlockType;
  onUndo: () => void;
  onRedo: () => void;
  onToggleBold: () => void;
  onToggleItalic: () => void;
  onToggleCode: () => void;
  onToggleStrikethrough: () => void;
  onSetBlockType: (type: BlockType) => void;
  onDismissKeyboard: () => void;
}

export function MobileKeyboardToolbar({
  isVisible,
  keyboardHeight,
  canUndo,
  canRedo,
  isBold,
  isItalic,
  isCode,
  isStrikethrough,
  currentBlockType,
  onUndo,
  onRedo,
  onToggleBold,
  onToggleItalic,
  onToggleCode,
  onToggleStrikethrough,
  onSetBlockType,
  onDismissKeyboard,
}: MobileKeyboardToolbarProps) {
  const { t } = useTranslation();
  const [blockPickerOpen, setBlockPickerOpen] = useState(false);

  const currentBlock = BLOCK_TYPES.find((b) => b.type === currentBlockType);

  const handleBlockTypeSelect = (type: BlockType) => {
    onSetBlockType(type);
    setBlockPickerOpen(false);
  };

  // Slide in from below on show, slide out on hide.
  // iOS (KeyboardResize.Native): keyboardHeight is always 0 — bottom stays fixed,
  // and translateY slides the bar up from just below the viewport edge.
  // Android: bottom jumps to keyboardHeight in one message, both properties
  // transition together so the bar rises with the keyboard.
  const easing = "cubic-bezier(0.4, 0, 0.2, 1)";
  const duration = isVisible ? "320ms" : "240ms";
  const style = {
    bottom: keyboardHeight,
    transform: isVisible ? "translateY(0)" : "translateY(100%)",
    transition: `transform ${duration} ${easing}, bottom ${duration} ${easing}`,
    willChange: "transform",
  };

  return (
    <div
      data-editor-overlay
      style={style}
      className="fixed left-0 right-0 z-50 flex flex-col"
      onTouchStart={(e) => e.stopPropagation()}
    >
      {/* Block type picker row — shown above toolbar when active */}
      {blockPickerOpen && (
        <div className="flex flex-row overflow-x-auto border-t border-border bg-background px-2 py-1.5 gap-1 no-scrollbar">
          {BLOCK_TYPES.map((block) => (
            <button
              key={block.type}
              onClick={() => handleBlockTypeSelect(block.type)}
              className={cn(
                "flex flex-col items-center justify-center gap-0.5 rounded-md px-3 py-2 min-w-[52px]",
                "transition-colors",
                currentBlockType === block.type
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground active:bg-muted",
              )}
            >
              {block.icon}
              <span className="text-[10px] leading-none whitespace-nowrap">
                {t(block.labelKey)}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Main toolbar row */}
      <div className="flex flex-row items-center border-t border-border bg-background h-12">
        {/* Undo / Redo */}
        <ToolbarButton
          onPress={onUndo}
          disabled={!canUndo}
          aria-label={t("editor.undo", "Undo")}
        >
          <Undo2 className="size-5" />
        </ToolbarButton>
        <ToolbarButton
          onPress={onRedo}
          disabled={!canRedo}
          aria-label={t("editor.redo", "Redo")}
        >
          <Redo2 className="size-5" />
        </ToolbarButton>

        <Divider />

        {/* Formatting */}
        <ToolbarButton
          onPress={onToggleBold}
          active={isBold}
          aria-label={t("editor.bold", "Bold")}
        >
          <Bold className="size-5" />
        </ToolbarButton>
        <ToolbarButton
          onPress={onToggleItalic}
          active={isItalic}
          aria-label={t("editor.italic", "Italic")}
        >
          <Italic className="size-5" />
        </ToolbarButton>
        <ToolbarButton
          onPress={onToggleCode}
          active={isCode}
          aria-label={t("editor.code", "Code")}
        >
          <Code className="size-5" />
        </ToolbarButton>
        <ToolbarButton
          onPress={onToggleStrikethrough}
          active={isStrikethrough}
          aria-label={t("editor.strikethrough", "Strikethrough")}
        >
          <Strikethrough className="size-5" />
        </ToolbarButton>

        <Divider />

        {/* Block type picker toggle */}
        <button
          onPointerDown={(e) => {
            e.preventDefault();
            setBlockPickerOpen((open) => !open);
          }}
          className={cn(
            "flex flex-row items-center gap-1 px-3 h-full",
            "transition-colors",
            blockPickerOpen
              ? "text-primary"
              : "text-muted-foreground active:bg-muted",
          )}
          aria-label={t("editor.blockType", "Block type")}
        >
          {currentBlock?.icon}
          <ChevronDown
            className={cn(
              "size-3.5 transition-transform",
              blockPickerOpen && "rotate-180",
            )}
          />
        </button>

        {/* Spacer */}
        <div className="flex-1" />

        <Divider />

        {/* Dismiss keyboard — no preventDefault so the input blurs and the keyboard closes */}
        <button
          onPointerDown={() => {
            onDismissKeyboard();
            if (document.activeElement instanceof HTMLElement) {
              document.activeElement.blur();
            }
          }}
          className="flex items-center justify-center w-11 h-full transition-colors text-muted-foreground active:bg-muted"
          aria-label={t("editor.dismissKeyboard", "Dismiss keyboard")}
        >
          <X className="size-5" />
        </button>
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
        // Prevent the hidden input from losing focus (which would hide the keyboard)
        e.preventDefault();
        if (!disabled) onPress();
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
  return (
    <div className="w-px h-6 bg-border mx-0.5 shrink-0" />
  );
}

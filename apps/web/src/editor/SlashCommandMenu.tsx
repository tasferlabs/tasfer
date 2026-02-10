import * as Popover from "@radix-ui/react-popover";
import {
  Heading1,
  Heading2,
  Heading3,
  Image,
  LayoutList,
  List,
  ListOrdered,
  Minus,
  Type,
} from "lucide-react";
import React, { useEffect, useMemo, useRef } from "react";
import { ScrollArea } from "../components/ui/scroll-area";
import type { SlashCommand } from "./types";

interface SlashCommandWithMeta extends SlashCommand {
  category: "basic" | "media" | "lists";
  shortcut?: string;
}

export const SLASH_COMMANDS: SlashCommandWithMeta[] = [
  {
    id: "heading1",
    type: "heading1",
    label: "Heading 1",
    description: "Big section heading.",
    icon: <Heading1 size={18} />,
    keywords: ["h1", "heading1", "heading 1", "1"],
    category: "basic",
    shortcut: "⌘1",
  },
  {
    id: "heading2",
    type: "heading2",
    label: "Heading 2",
    description: "Medium section heading.",
    icon: <Heading2 size={18} />,
    keywords: ["h2", "heading2", "heading 2", "2"],
    category: "basic",
    shortcut: "⌘2",
  },
  {
    id: "heading3",
    type: "heading3",
    label: "Heading 3",
    description: "Small section heading.",
    icon: <Heading3 size={18} />,
    keywords: ["h3", "heading3", "heading 3", "3"],
    category: "basic",
    shortcut: "⌘3",
  },
  {
    id: "paragraph",
    type: "paragraph",
    label: "Text",
    description: "Regular text.",
    icon: <Type size={18} />,
    keywords: ["text", "paragraph", "para", "p", "t"],
    category: "basic",
    shortcut: "⌘T",
  },
  {
    id: "line",
    type: "line",
    label: "Divider",
    description: "Horizontal line divider.",
    icon: <Minus size={18} />,
    keywords: ["line", "divider", "hr", "horizontal", "separator", "---"],
    category: "basic",
    shortcut: "⌘-",
  },
  {
    id: "image",
    type: "image",
    label: "Image",
    description: "Add a suitable image.",
    icon: <Image size={18} />,
    keywords: ["image", "img", "picture", "photo", "upload"],
    category: "media",
    shortcut: "⌘I",
  },
  {
    id: "bullet_list",
    type: "bullet_list",
    label: "Bullet List",
    description: "Create a simple bullet list.",
    icon: <List size={18} />,
    keywords: ["bullet", "list", "ul", "-", "unordered"],
    category: "lists",
    shortcut: "⌘U",
  },
  {
    id: "numbered_list",
    type: "numbered_list",
    label: "Numbered List",
    description: "Create a numbered list.",
    icon: <ListOrdered size={18} />,
    keywords: ["numbered", "list", "ol", "1.", "ordered"],
    category: "lists",
    shortcut: "⌘O",
  },
  {
    id: "todo_list",
    type: "todo_list",
    label: "To-do List",
    description: "Track tasks with a checklist.",
    icon: <LayoutList size={18} />,
    keywords: ["todo", "task", "check", "checkbox", "[]"],
    category: "lists",
    shortcut: "⌘L",
  },
];

const CATEGORY_LABELS: Record<string, string> = {
  basic: "Basic blocks",
  media: "Media",
  lists: "Lists",
};

interface SlashCommandMenuProps {
  x: number;
  y: number;
  selectedIndex: number;
  filter?: string;
  onSelect: (command: SlashCommand) => void;
  onClose: () => void;
}

export const SlashCommandMenu: React.FC<SlashCommandMenuProps> = ({
  x,
  y,
  selectedIndex,
  filter = "",
  onSelect,
  onClose,
}) => {
  const selectedRef = useRef<HTMLButtonElement>(null);

  // Calculate max height based on available viewport space
  const maxHeight = useMemo(() => {
    const viewportHeight =
      typeof window !== "undefined" ? window.innerHeight : 800;
    const padding = 20; // Padding from viewport edge
    const sideOffset = 5; // Same as sideOffset prop
    const availableSpace = viewportHeight - y - padding - sideOffset;
    const maxAllowed = 400;
    return Math.max(150, Math.min(maxAllowed, availableSpace));
  }, [y]);

  // Filter commands based on input
  const filteredCommands = React.useMemo(() => {
    if (!filter) return SLASH_COMMANDS;
    const lowerFilter = filter.toLowerCase();
    return SLASH_COMMANDS.filter(
      (cmd) =>
        cmd.label.toLowerCase().includes(lowerFilter) ||
        cmd.description.toLowerCase().includes(lowerFilter) ||
        cmd.keywords?.some((keyword) =>
          keyword.toLowerCase().startsWith(lowerFilter)
        )
    );
  }, [filter]);

  // Group commands by category
  const groupedCommands = React.useMemo(() => {
    const groups: Record<string, SlashCommandWithMeta[]> = {};
    for (const cmd of filteredCommands) {
      if (!groups[cmd.category]) {
        groups[cmd.category] = [];
      }
      groups[cmd.category].push(cmd);
    }
    return groups;
  }, [filteredCommands]);

  // Auto-close menu when no commands match
  useEffect(() => {
    if (filter && filteredCommands.length === 0) {
      onClose();
    }
  }, [filter, filteredCommands.length, onClose]);

  // Scroll selected item into view
  useEffect(() => {
    if (selectedRef.current) {
      selectedRef.current.scrollIntoView({
        block: "nearest",
        behavior: "smooth",
      });
    }
  }, [selectedIndex]);

  if (filteredCommands.length === 0) {
    return null;
  }

  // Calculate the flat index for each command
  let currentIndex = 0;

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
      <Popover.Portal>
        <Popover.Content
          className="bg-popover rounded-xl shadow-lg border border-border/50 min-w-[320px] max-w-[380px] z-50 select-none overflow-hidden"
          side="bottom"
          align="start"
          sideOffset={5}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <ScrollArea style={{ maxHeight }}>
            <div className="py-2">
              {Object.entries(groupedCommands).map(([category, commands]) => (
                <div key={category}>
                  <div className="px-4 py-2 text-xs font-medium text-muted-foreground/70 uppercase tracking-wide">
                    {CATEGORY_LABELS[category] || category}
                  </div>
                  {commands.map((command) => {
                    const index = currentIndex++;
                    const isSelected = index === selectedIndex;
                    return (
                      <button
                        key={command.id}
                        ref={isSelected ? selectedRef : null}
                        className={`w-full px-3 py-2 flex items-center gap-3 transition-colors ${
                          isSelected ? "bg-accent" : "hover:bg-accent/50"
                        }`}
                        onClick={() => onSelect(command)}
                        onMouseDown={(e) => {
                          e.preventDefault();
                        }}
                      >
                        <div
                          className={`flex-shrink-0 w-9 h-9 rounded-lg flex items-center justify-center transition-colors ${
                            isSelected
                              ? "bg-primary/15 text-primary"
                              : "bg-muted/60 text-muted-foreground"
                          }`}
                        >
                          {command.icon}
                        </div>
                        <div className="flex-1 text-left min-w-0">
                          <div
                            className={`font-medium text-sm ${
                              isSelected
                                ? "text-primary"
                                : "text-popover-foreground"
                            }`}
                          >
                            {command.label}
                          </div>
                          <div className="text-xs text-muted-foreground truncate">
                            {command.description}
                          </div>
                        </div>
                        {command.shortcut && (
                          <div className="flex-shrink-0 text-xs text-muted-foreground/60 font-mono">
                            {command.shortcut}
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </ScrollArea>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
};

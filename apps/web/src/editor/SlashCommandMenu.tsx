import * as Popover from "@radix-ui/react-popover";
import { Heading1, Heading2, Heading3, Image, LayoutList, List, ListOrdered, Type } from "lucide-react";
import React, { useEffect } from "react";
import type { SlashCommand } from "./types";

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    id: "paragraph",
    type: "paragraph",
    label: "Text",
    description: "Just start typing with plain text.",
    icon: <Type size={20} />,
    keywords: ["text", "paragraph", "para", "p", "t"],
  },
  {
    id: "heading1",
    type: "heading1",
    label: "Heading 1",
    description: "Big section heading.",
    icon: <Heading1 size={20} />,
    keywords: ["h1", "heading1", "heading 1", "1"],
  },
  {
    id: "heading2",
    type: "heading2",
    label: "Heading 2",
    description: "Medium section heading.",
    icon: <Heading2 size={20} />,
    keywords: ["h2", "heading2", "heading 2", "2"],
  },
  {
    id: "heading3",
    type: "heading3",
    label: "Heading 3",
    description: "Small section heading.",
    icon: <Heading3 size={20} />,
    keywords: ["h3", "heading3", "heading 3", "3"],
  },
  {
    id: "image",
    type: "image",
    label: "Image",
    description: "Image block.",
    icon: <Image size={20} />,
    keywords: ["image", "img", "picture", "photo", "upload"],
  },
  {
    id: "bullet_list",
    type: "bullet_list",
    label: "Bullet List",
    description: "Create a simple bullet list.",
    icon: <List size={20} />,
    keywords: ["bullet", "list", "ul", "-", "unordered"],
  },
  {
    id: "numbered_list",
    type: "numbered_list",
    label: "Numbered List",
    description: "Create a numbered list.",
    icon: <ListOrdered size={20} />,
    keywords: ["numbered", "list", "ol", "1.", "ordered"],
  },
  {
    id: "todo_list",
    type: "todo_list",
    label: "To-do List",
    description: "Track tasks with a checklist.",
    icon: <LayoutList size={20} />,
    keywords: ["todo", "task", "check", "checkbox", "[]"],
  },
];

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
  // Filter commands based on input
  const filteredCommands = React.useMemo(() => {
    if (!filter) return SLASH_COMMANDS;
    const lowerFilter = filter.toLowerCase();
    return SLASH_COMMANDS.filter(
      (cmd) =>
        cmd.label.toLowerCase().includes(lowerFilter) ||
        cmd.description.toLowerCase().includes(lowerFilter) ||
        cmd.keywords?.some((keyword) => keyword.toLowerCase().startsWith(lowerFilter))
    );
  }, [filter]);

  // Auto-close menu when no commands match
  useEffect(() => {
    if (filter && filteredCommands.length === 0) {
      onClose();
    }
  }, [filter, filteredCommands.length, onClose]);

  if (filteredCommands.length === 0) {
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
      <Popover.Portal>
        <Popover.Content
          className="bg-popover rounded-lg shadow-xl border border-border py-2 min-w-[320px] max-w-[400px] z-50 max-h-[400px] overflow-y-auto select-none"
          side="bottom"
          align="start"
          sideOffset={5}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          {filteredCommands.map((command, index) => (
            <button
              key={command.id}
              className={`w-full px-3 py-2.5 flex items-start gap-3 hover:bg-accent transition-colors ${
                index === selectedIndex ? "bg-accent/50 hover:bg-accent/70" : ""
              }`}
              onClick={() => onSelect(command)}
              onMouseDown={(e) => {
                // Prevent button from taking focus away from hidden input
                e.preventDefault();
              }}
            >
              <div
                className={`flex-shrink-0 w-10 h-10 rounded-md flex items-center justify-center text-sm font-semibold ${
                  index === selectedIndex
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                {command.icon}
              </div>
              <div className="flex-1 text-left">
                <div className="font-medium text-sm text-popover-foreground">
                  {command.label}
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  {command.description}
                </div>
              </div>
            </button>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
};


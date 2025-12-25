import React, { useEffect } from "react";
import * as Popover from "@radix-ui/react-popover";
import type { SlashCommand } from "./types";

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    id: "paragraph",
    type: "paragraph",
    label: "Text",
    description: "Just start typing with plain text.",
    icon: "T",
    keywords: ["text", "paragraph", "para", "p", "t"],
  },
  {
    id: "heading1",
    type: "heading1",
    label: "Heading 1",
    description: "Big section heading.",
    icon: "H1",
    keywords: ["h1", "heading1", "heading 1", "1"],
  },
  {
    id: "heading2",
    type: "heading2",
    label: "Heading 2",
    description: "Medium section heading.",
    icon: "H2",
    keywords: ["h2", "heading2", "heading 2", "2"],
  },
  {
    id: "heading3",
    type: "heading3",
    label: "Heading 3",
    description: "Small section heading.",
    icon: "H3",
    keywords: ["h3", "heading3", "heading 3", "3"],
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
          className="bg-white rounded-lg shadow-xl border border-gray-200 py-2 min-w-[320px] max-w-[400px] z-50 max-h-[400px] overflow-y-auto"
          side="bottom"
          align="start"
          sideOffset={5}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          {filteredCommands.map((command, index) => (
            <button
              key={command.id}
              className={`w-full px-3 py-2.5 flex items-start gap-3 hover:bg-gray-100 transition-colors ${
                index === selectedIndex ? "bg-blue-50 hover:bg-blue-100" : ""
              }`}
              onClick={() => onSelect(command)}
            >
              <div
                className={`flex-shrink-0 w-10 h-10 rounded-md flex items-center justify-center text-sm font-semibold ${
                  index === selectedIndex
                    ? "bg-blue-500 text-white"
                    : "bg-gray-100 text-gray-600"
                }`}
              >
                {command.icon}
              </div>
              <div className="flex-1 text-left">
                <div className="font-medium text-sm text-gray-900">
                  {command.label}
                </div>
                <div className="text-xs text-gray-500 mt-0.5">
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


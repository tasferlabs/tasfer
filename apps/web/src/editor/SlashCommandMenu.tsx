import * as Popover from "@radix-ui/react-popover";
import i18next from "i18next";
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
import { useTranslation } from "react-i18next";
import { ScrollArea } from "../components/ui/scroll-area";
import type { SlashCommand } from "./types";

interface SlashCommandWithMeta extends SlashCommand {
  category: "basic" | "media" | "lists";
}

function useSlashCommands(): SlashCommandWithMeta[] {
  const { t } = useTranslation();
  return useMemo(
    () => [
      {
        id: "heading1",
        type: "heading1" as const,
        label: t("Heading 1"),
        description: t("Big section heading."),
        icon: <Heading1 size={18} />,
        keywords: ["h1", "heading", t("heading"), "1"],
        category: "basic" as const,
      },
      {
        id: "heading2",
        type: "heading2" as const,
        label: t("Heading 2"),
        description: t("Medium section heading."),
        icon: <Heading2 size={18} />,
        keywords: ["h2", "heading", t("heading"), "2"],
        category: "basic" as const,
      },
      {
        id: "heading3",
        type: "heading3" as const,
        label: t("Heading 3"),
        description: t("Small section heading."),
        icon: <Heading3 size={18} />,
        keywords: ["h3", "heading", t("heading"), "3"],
        category: "basic" as const,
      },
      {
        id: "paragraph",
        type: "paragraph" as const,
        label: t("Text"),
        description: t("Regular text."),
        icon: <Type size={18} />,
        keywords: ["text", t("text"), "paragraph", t("paragraph"), "p"],
        category: "basic" as const,
      },
      {
        id: "line",
        type: "line" as const,
        label: t("Divider"),
        description: t("Horizontal line divider."),
        icon: <Minus size={18} />,
        keywords: ["line", t("line"), "divider", t("divider"), "hr", "horizontal", t("horizontal"), "separator", t("separator"), "---"],
        category: "basic" as const,
      },
      {
        id: "image",
        type: "image" as const,
        label: t("Image"),
        description: t("Add a suitable image."),
        icon: <Image size={18} />,
        keywords: ["image", t("image"), "img", "picture", t("picture"), "photo", t("photo"), "upload", t("upload")],
        category: "media" as const,
      },
      {
        id: "bullet_list",
        type: "bullet_list" as const,
        label: t("Bullet List"),
        description: t("Create a simple bullet list."),
        icon: <List size={18} />,
        keywords: ["bullet", t("bullet"), "list", t("list"), "ul", "-", "unordered", t("unordered")],
        category: "lists" as const,
      },
      {
        id: "numbered_list",
        type: "numbered_list" as const,
        label: t("Numbered List"),
        description: t("Create a numbered list."),
        icon: <ListOrdered size={18} />,
        keywords: ["numbered", t("numbered"), "list", t("list"), "ol", "1.", "ordered", t("ordered")],
        category: "lists" as const,
      },
      {
        id: "todo_list",
        type: "todo_list" as const,
        label: t("To-do List"),
        description: t("Track tasks with a checklist."),
        icon: <LayoutList size={18} />,
        keywords: ["todo", t("todo"), "task", t("task"), "check", t("check"), "checkbox", t("checkbox"), "[]"],
        category: "lists" as const,
      },
    ],
    [t],
  );
}

function useCategoryLabels(): Record<string, string> {
  const { t } = useTranslation();
  return useMemo(
    () => ({
      basic: t("Basic blocks"),
      media: t("Media"),
      lists: t("Lists"),
    }),
    [t],
  );
}

/**
 * Non-React getter for slash commands with current translations.
 * Used by keysEvents.ts and other non-component code.
 */
export function getSlashCommands(): SlashCommandWithMeta[] {
  const t = i18next.t.bind(i18next);
  return [
    {
      id: "heading1",
      type: "heading1",
      label: t("Heading 1"),
      description: t("Big section heading."),
      icon: "",
      keywords: ["h1", "heading", t("heading"), "1"],
      category: "basic",
    },
    {
      id: "heading2",
      type: "heading2",
      label: t("Heading 2"),
      description: t("Medium section heading."),
      icon: "",
      keywords: ["h2", "heading", t("heading"), "2"],
      category: "basic",
    },
    {
      id: "heading3",
      type: "heading3",
      label: t("Heading 3"),
      description: t("Small section heading."),
      icon: "",
      keywords: ["h3", "heading", t("heading"), "3"],
      category: "basic",
    },
    {
      id: "paragraph",
      type: "paragraph",
      label: t("Text"),
      description: t("Regular text."),
      icon: "",
      keywords: ["text", t("text"), "paragraph", t("paragraph"), "p"],
      category: "basic",
    },
    {
      id: "line",
      type: "line",
      label: t("Divider"),
      description: t("Horizontal line divider."),
      icon: "",
      keywords: ["line", t("line"), "divider", t("divider"), "hr", "horizontal", t("horizontal"), "separator", t("separator"), "---"],
      category: "basic",
    },
    {
      id: "image",
      type: "image",
      label: t("Image"),
      description: t("Add a suitable image."),
      icon: "",
      keywords: ["image", t("image"), "img", "picture", t("picture"), "photo", t("photo"), "upload", t("upload")],
      category: "media",
    },
    {
      id: "bullet_list",
      type: "bullet_list",
      label: t("Bullet List"),
      description: t("Create a simple bullet list."),
      icon: "",
      keywords: ["bullet", t("bullet"), "list", t("list"), "ul", "-", "unordered", t("unordered")],
      category: "lists",
    },
    {
      id: "numbered_list",
      type: "numbered_list",
      label: t("Numbered List"),
      description: t("Create a numbered list."),
      icon: "",
      keywords: ["numbered", t("numbered"), "list", t("list"), "ol", "1.", "ordered", t("ordered")],
      category: "lists",
    },
    {
      id: "todo_list",
      type: "todo_list",
      label: t("To-do List"),
      description: t("Track tasks with a checklist."),
      icon: "",
      keywords: ["todo", t("todo"), "task", t("task"), "check", t("check"), "checkbox", t("checkbox"), "[]"],
      category: "lists",
    },
  ];
}

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
  const slashCommands = useSlashCommands();
  const categoryLabels = useCategoryLabels();

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
    if (!filter) return slashCommands;
    const lowerFilter = filter.toLowerCase();
    return slashCommands.filter(
      (cmd) =>
        cmd.label.toLowerCase().includes(lowerFilter) ||
        cmd.description.toLowerCase().includes(lowerFilter) ||
        cmd.keywords?.some((keyword) =>
          keyword.toLowerCase().startsWith(lowerFilter)
        )
    );
  }, [filter, slashCommands]);

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
                    {categoryLabels[category] || category}
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
                        <div className="flex-1 text-start min-w-0">
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

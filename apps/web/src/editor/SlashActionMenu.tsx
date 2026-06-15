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
  Sigma,
  Type,
} from "lucide-react";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollArea } from "../components/ui/scroll-area";
import {
  type Editor,
  SLASH_CONFIRM,
  SLASH_NAVIGATE,
} from "@cypherkit/editor";
import type { SlashAction } from "@cypherkit/editor";

interface SlashActionWithMeta extends SlashAction {
  category: "basic" | "media" | "lists";
}

function useSlashActions(): SlashActionWithMeta[] {
  const { t } = useTranslation();
  return useMemo(
    () => [
      {
        id: "heading1",
        type: "heading1" as const,
        label: t("blocks.heading1", "Heading 1"),
        description: t("blocks.desc.bigSection", "Big section heading."),
        icon: <Heading1 size={18} />,
        keywords: ["h1", "heading", t("blocks.headingKw", "heading"), "1"],
        category: "basic" as const,
      },
      {
        id: "heading2",
        type: "heading2" as const,
        label: t("blocks.heading2", "Heading 2"),
        description: t("blocks.desc.mediumSection", "Medium section heading."),
        icon: <Heading2 size={18} />,
        keywords: ["h2", "heading", t("blocks.headingKw", "heading"), "2"],
        category: "basic" as const,
      },
      {
        id: "heading3",
        type: "heading3" as const,
        label: t("blocks.heading3", "Heading 3"),
        description: t("blocks.desc.smallSection", "Small section heading."),
        icon: <Heading3 size={18} />,
        keywords: ["h3", "heading", t("blocks.headingKw", "heading"), "3"],
        category: "basic" as const,
      },
      {
        id: "paragraph",
        type: "paragraph" as const,
        label: t("common.text", "Text"),
        description: t("blocks.desc.regularText", "Regular text."),
        icon: <Type size={18} />,
        keywords: ["text", t("blocks.textKw", "text"), "paragraph", t("blocks.paragraphKw", "paragraph"), "p"],
        category: "basic" as const,
      },
      {
        id: "line",
        type: "line" as const,
        label: t("blocks.divider", "Divider"),
        description: t("blocks.desc.divider", "Horizontal line divider."),
        icon: <Minus size={18} />,
        keywords: ["line", t("blocks.lineKw", "line"), "divider", t("blocks.dividerKw", "divider"), "hr", "horizontal", t("blocks.horizontalKw", "horizontal"), "separator", t("blocks.separatorKw", "separator"), "---"],
        category: "basic" as const,
      },
      {
        id: "image",
        type: "image" as const,
        label: t("blocks.image", "Image"),
        description: t("image.addSuitable", "Add a suitable image."),
        icon: <Image size={18} />,
        keywords: ["image", t("blocks.imageKw", "image"), "img", "picture", t("blocks.pictureKw", "picture"), "photo", t("blocks.photoKw", "photo"), "upload", t("blocks.uploadKw", "upload")],
        category: "media" as const,
      },
      {
        id: "math",
        type: "math" as const,
        label: t("blocks.math", "Math Equation"),
        description: t("blocks.desc.math", "LaTeX math expression."),
        icon: <Sigma size={18} />,
        keywords: ["math", t("blocks.mathKw", "math"), "equation", t("blocks.equationKw", "equation"), "latex", "formula", t("blocks.formulaKw", "formula"), "$$"],
        category: "media" as const,
      },
      {
        id: "bullet_list",
        type: "bullet_list" as const,
        label: t("blocks.bulletList", "Bullet List"),
        description: t("blocks.desc.bulletList", "Create a simple bullet list."),
        icon: <List size={18} />,
        keywords: ["bullet", t("blocks.bulletKw", "bullet"), "list", t("blocks.listKw", "list"), "ul", "-", "unordered", t("blocks.unorderedKw", "unordered")],
        category: "lists" as const,
      },
      {
        id: "numbered_list",
        type: "numbered_list" as const,
        label: t("blocks.numberedList", "Numbered List"),
        description: t("blocks.desc.numberedList", "Create a numbered list."),
        icon: <ListOrdered size={18} />,
        keywords: ["numbered", t("blocks.numberedKw", "numbered"), "list", t("blocks.listKw", "list"), "ol", "1.", "ordered", t("blocks.orderedKw", "ordered")],
        category: "lists" as const,
      },
      {
        id: "todo_list",
        type: "todo_list" as const,
        label: t("blocks.todoList", "To-do List"),
        description: t("blocks.desc.todoList", "Track tasks with a checklist."),
        icon: <LayoutList size={18} />,
        keywords: ["todo", t("blocks.todoKw", "todo"), "task", t("calendar.taskKw", "task"), "check", t("blocks.checkKw", "check"), "checkbox", t("blocks.checkboxKw", "checkbox"), "[]"],
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
      basic: t("blocks.basicBlocks", "Basic blocks"),
      media: t("blocks.media", "Media"),
      lists: t("blocks.lists", "Lists"),
    }),
    [t],
  );
}

/**
 * Non-React getter for slash actions with current translations.
 * Used by keysEvents.ts and other non-component code.
 */
export function getSlashActions(): SlashActionWithMeta[] {
  const t = i18next.t.bind(i18next);
  return [
    {
      id: "heading1",
      type: "heading1",
      label: t("blocks.heading1", "Heading 1"),
      description: t("blocks.desc.bigSection", "Big section heading."),
      icon: "",
      keywords: ["h1", "heading", t("blocks.headingKw", "heading"), "1"],
      category: "basic",
    },
    {
      id: "heading2",
      type: "heading2",
      label: t("blocks.heading2", "Heading 2"),
      description: t("blocks.desc.mediumSection", "Medium section heading."),
      icon: "",
      keywords: ["h2", "heading", t("blocks.headingKw", "heading"), "2"],
      category: "basic",
    },
    {
      id: "heading3",
      type: "heading3",
      label: t("blocks.heading3", "Heading 3"),
      description: t("blocks.desc.smallSection", "Small section heading."),
      icon: "",
      keywords: ["h3", "heading", t("blocks.headingKw", "heading"), "3"],
      category: "basic",
    },
    {
      id: "paragraph",
      type: "paragraph",
      label: t("common.text", "Text"),
      description: t("blocks.desc.regularText", "Regular text."),
      icon: "",
      keywords: ["text", t("blocks.textKw", "text"), "paragraph", t("blocks.paragraphKw", "paragraph"), "p"],
      category: "basic",
    },
    {
      id: "line",
      type: "line",
      label: t("blocks.divider", "Divider"),
      description: t("blocks.desc.divider", "Horizontal line divider."),
      icon: "",
      keywords: ["line", t("blocks.lineKw", "line"), "divider", t("blocks.dividerKw", "divider"), "hr", "horizontal", t("blocks.horizontalKw", "horizontal"), "separator", t("blocks.separatorKw", "separator"), "---"],
      category: "basic",
    },
    {
      id: "image",
      type: "image",
      label: t("blocks.image", "Image"),
      description: t("image.addSuitable", "Add a suitable image."),
      icon: "",
      keywords: ["image", t("blocks.imageKw", "image"), "img", "picture", t("blocks.pictureKw", "picture"), "photo", t("blocks.photoKw", "photo"), "upload", t("blocks.uploadKw", "upload")],
      category: "media",
    },
    {
      id: "math",
      type: "math",
      label: t("blocks.math", "Math Equation"),
      description: t("blocks.desc.math", "LaTeX math expression."),
      icon: "",
      keywords: ["math", t("blocks.mathKw", "math"), "equation", t("blocks.equationKw", "equation"), "latex", "formula", t("blocks.formulaKw", "formula"), "$$"],
      category: "media",
    },
    {
      id: "bullet_list",
      type: "bullet_list",
      label: t("blocks.bulletList", "Bullet List"),
      description: t("blocks.desc.bulletList", "Create a simple bullet list."),
      icon: "",
      keywords: ["bullet", t("blocks.bulletKw", "bullet"), "list", t("blocks.listKw", "list"), "ul", "-", "unordered", t("blocks.unorderedKw", "unordered")],
      category: "lists",
    },
    {
      id: "numbered_list",
      type: "numbered_list",
      label: t("blocks.numberedList", "Numbered List"),
      description: t("blocks.desc.numberedList", "Create a numbered list."),
      icon: "",
      keywords: ["numbered", t("blocks.numberedKw", "numbered"), "list", t("blocks.listKw", "list"), "ol", "1.", "ordered", t("blocks.orderedKw", "ordered")],
      category: "lists",
    },
    {
      id: "todo_list",
      type: "todo_list",
      label: t("blocks.todoList", "To-do List"),
      description: t("blocks.desc.todoList", "Track tasks with a checklist."),
      icon: "",
      keywords: ["todo", t("blocks.todoKw", "todo"), "task", t("calendar.taskKw", "task"), "check", t("blocks.checkKw", "check"), "checkbox", t("blocks.checkboxKw", "checkbox"), "[]"],
      category: "lists",
    },
  ];
}

interface SlashActionMenuProps {
  /** The editor whose action bus relays keyboard nav/confirm to this menu. */
  editor: Editor;
  x: number;
  y: number;
  filter?: string;
  onSelect: (action: SlashAction) => void;
  onClose: () => void;
}

export const SlashActionMenu: React.FC<SlashActionMenuProps> = ({
  editor,
  x,
  y,
  filter = "",
  onSelect,
  onClose,
}) => {
  const selectedRef = useRef<HTMLButtonElement>(null);
  const slashActions = useSlashActions();
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

  // Filter actions based on input
  const filteredActions = React.useMemo(() => {
    if (!filter) return slashActions;
    const lowerFilter = filter.toLowerCase();
    return slashActions.filter(
      (cmd) =>
        cmd.label.toLowerCase().includes(lowerFilter) ||
        cmd.description.toLowerCase().includes(lowerFilter) ||
        cmd.keywords?.some((keyword) =>
          keyword.toLowerCase().startsWith(lowerFilter)
        )
    );
  }, [filter, slashActions]);

  // Group actions by category
  const groupedActions = React.useMemo(() => {
    const groups: Record<string, SlashActionWithMeta[]> = {};
    for (const cmd of filteredActions) {
      if (!groups[cmd.category]) {
        groups[cmd.category] = [];
      }
      groups[cmd.category].push(cmd);
    }
    return groups;
  }, [filteredActions]);

  // Grouped order is the order the list renders in; the selection indexes into
  // this flat list (NOT raw `filteredActions`, which isn't grouped).
  const flatActions = useMemo(
    () => Object.values(groupedActions).flat(),
    [groupedActions],
  );

  // The engine owns opening the menu and the `/filter` text and relays
  // navigation/confirmation to us over the action bus; we own the list and the
  // current selection.
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Reset the highlight whenever the filter changes (the list just changed).
  useEffect(() => {
    setSelectedIndex(0);
  }, [filter]);

  // Refs so the once-registered action handlers always read the latest values.
  const selectedIndexRef = useRef(0);
  selectedIndexRef.current = selectedIndex;
  const flatActionsRef = useRef(flatActions);
  flatActionsRef.current = flatActions;

  useEffect(() => {
    const offNavigate = editor.registerAction(
      SLASH_NAVIGATE,
      ({ direction }) => {
        setSelectedIndex((i) => {
          const len = flatActionsRef.current.length;
          if (len === 0) return 0;
          return direction === "down"
            ? Math.min(i + 1, len - 1)
            : Math.max(i - 1, 0);
        });
        return true;
      },
    );
    // Enter: hand the engine our selected action. It applies it in-flow, so we
    // must NOT call `executeSlashAction` here (that would mutate editor state
    // mid-frame); `confirm` is the engine's own callback.
    const offConfirm = editor.registerAction(SLASH_CONFIRM, ({ confirm }) => {
      const action = flatActionsRef.current[selectedIndexRef.current];
      if (!action) return false;
      confirm(action);
      return true;
    });
    return () => {
      offNavigate();
      offConfirm();
    };
  }, [editor]);

  // Auto-close menu when no actions match
  useEffect(() => {
    if (filter && filteredActions.length === 0) {
      onClose();
    }
  }, [filter, filteredActions.length, onClose]);

  // Scroll selected item into view
  useEffect(() => {
    if (selectedRef.current) {
      selectedRef.current.scrollIntoView({
        block: "nearest",
        behavior: "smooth",
      });
    }
  }, [selectedIndex]);

  if (filteredActions.length === 0) {
    return null;
  }

  // Calculate the flat index for each action
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
              {Object.entries(groupedActions).map(([category, actions]) => (
                <div key={category}>
                  <div className="px-4 py-2 text-xs font-medium text-muted-foreground/70 uppercase tracking-wide">
                    {categoryLabels[category] || category}
                  </div>
                  {actions.map((action) => {
                    const index = currentIndex++;
                    const isSelected = index === selectedIndex;
                    return (
                      <button
                        key={action.id}
                        ref={isSelected ? selectedRef : null}
                        className={`w-full px-3 py-2 flex items-center gap-3 transition-colors ${
                          isSelected ? "bg-accent" : "hover:bg-accent/50"
                        }`}
                        onClick={() => onSelect(action)}
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
                          {action.icon}
                        </div>
                        <div className="flex-1 text-start min-w-0">
                          <div
                            className={`font-medium text-sm ${
                              isSelected
                                ? "text-primary"
                                : "text-popover-foreground"
                            }`}
                          >
                            {action.label}
                          </div>
                          <div className="text-xs text-muted-foreground truncate">
                            {action.description}
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

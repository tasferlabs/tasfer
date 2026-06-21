import * as Popover from "@radix-ui/react-popover";
import {
  Code2,
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
import React, {
  type ReactElement,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { EditActions, type Editor, TEXT_INPUT } from "@cypherkit/editor";
import {
  getBlockTextContent,
  isTouchDevice,
} from "@cypherkit/editor/internal";
import { ScrollArea } from "../components/ui/scroll-area";

/** Block types the slash menu can insert. Assignable to the engine's `Block["type"]`. */
export type SlashBlockType =
  | "heading1"
  | "heading2"
  | "heading3"
  | "paragraph"
  | "line"
  | "image"
  | "math"
  | "code"
  | "bullet_list"
  | "numbered_list"
  | "todo_list";

/**
 * One entry in the slash menu. Pure host UI — the engine has no notion of it.
 * `type` is the block this entry inserts (via the `EditActions.CONVERT_BLOCK` command).
 */
export interface SlashItem {
  id: string;
  type: SlashBlockType;
  label: string;
  description: string;
  icon: ReactElement;
  keywords: string[];
  category: "basic" | "media" | "lists";
}

function useSlashActions(): SlashItem[] {
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
        id: "code",
        type: "code" as const,
        label: t("blocks.code", "Code"),
        description: t("blocks.desc.code", "Editable code block."),
        icon: <Code2 size={18} />,
        keywords: ["code", t("blocks.codeKw", "code"), "snippet", t("blocks.snippetKw", "snippet"), "monospace", "```", "pre"],
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
interface SlashActionMenuProps {
  /** The editor this menu observes for `/` input and drives via `EditActions.CONVERT_BLOCK`. */
  editor: Editor;
  /** The editor surface's viewport rect, for translating caret coords to screen. */
  getContainerRect: () => DOMRect | null | undefined;
}

/**
 * Slash menu — a self-contained host component, always mounted. The engine has
 * no notion of it: this observes the generic {@link TEXT_INPUT} command to
 * edge-trigger opening on a typed `/` (so it won't reopen on later keystrokes
 * once dismissed with the `/` still in the text), recomputes the filter/anchor
 * from editor state on every change via `subscribe`, and applies the chosen
 * block through the {@link EditActions.CONVERT_BLOCK} command + unified change API. Renders
 * nothing while closed.
 */
export const SlashActionMenu: React.FC<SlashActionMenuProps> = ({
  editor,
  getContainerRect,
}) => {
  // Open trigger lives in a ref (mutated synchronously inside the TEXT_INPUT
  // handler, before the `/` commits) so the very next `subscribe` tick — which
  // fires after the commit — sees it and computes the anchor/filter.
  const triggerRef = useRef<{ blockIndex: number; slashIndex: number } | null>(
    null,
  );
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    filter: string;
  } | null>(null);

  const close = React.useCallback(() => {
    triggerRef.current = null;
    setMenu(null);
  }, []);

  const select = React.useCallback(
    (item: SlashItem) => {
      const t = triggerRef.current;
      if (!t) return;
      const cur = editor.getState()?.document.cursor;
      const blockId = cur
        ? editor.getState()?.document.page.blocks[cur.position.blockIndex]?.id
        : undefined;
      // Strip the typed "/filter" trigger text before converting (one undo step).
      const strip =
        blockId && cur
          ? {
              from: { block: blockId, offset: t.slashIndex },
              to: { block: blockId, offset: cur.position.textIndex },
            }
          : undefined;
      editor.dispatch(EditActions.CONVERT_BLOCK, { type: item.type, strip });
      close();
    },
    [editor, close],
  );

  useEffect(() => {
    const recompute = () => {
      const t = triggerRef.current;
      if (!t) return;
      const st = editor.getState();
      const cur = st?.document.cursor;
      if (!st || !cur) {
        close();
        return;
      }
      const block = st.document.page.blocks[t.blockIndex];
      if (!block) {
        close();
        return;
      }
      const text = getBlockTextContent(block);
      const cursorIndex = cur.position.textIndex;
      // Close when the caret has left the slash run: different block, moved at
      // or before the `/`, or the `/` itself was deleted.
      if (
        cur.position.blockIndex !== t.blockIndex ||
        cursorIndex <= t.slashIndex ||
        text[t.slashIndex] !== "/"
      ) {
        close();
        return;
      }
      const filter = text.slice(t.slashIndex + 1, cursorIndex);
      const coords = editor.coordsAtPos({
        blockIndex: t.blockIndex,
        textIndex: t.slashIndex,
      });
      const rect = getContainerRect();
      if (!coords || !rect) return;
      const x = rect.left + coords.x;
      const y = rect.top + coords.y + coords.height;
      setMenu((prev) =>
        prev && prev.x === x && prev.y === y && prev.filter === filter
          ? prev
          : { x, y, filter },
      );
    };

    // Edge-trigger the open on a typed `/` (desktop only — the menu is
    // keyboard-driven). The `/` isn't committed yet here, so the anchor/filter
    // are computed on the next `subscribe` tick.
    const offInput = editor.registerAction(
      TEXT_INPUT,
      ({ text, blockIndex, textIndex }) => {
        if (text !== "/" || isTouchDevice()) return;
        triggerRef.current = { blockIndex, slashIndex: textIndex };
      },
    );
    const offSub = editor.subscribe(recompute);
    return () => {
      offInput();
      offSub();
    };
  }, [editor, getContainerRect, close]);

  if (!menu) return null;
  return (
    <SlashMenuList
      x={menu.x}
      y={menu.y}
      filter={menu.filter}
      onSelect={select}
      onClose={close}
    />
  );
};

interface SlashMenuListProps {
  x: number;
  y: number;
  filter?: string;
  onSelect: (item: SlashItem) => void;
  onClose: () => void;
}

const SlashMenuList: React.FC<SlashMenuListProps> = ({
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
    const groups: Record<string, SlashItem[]> = {};
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

  // We own the list and the current selection. The host plugin owns opening the
  // menu and the `/filter` text (recomputed from the document); navigation keys
  // are captured here, in the DOM, since the engine has no menu concept.
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Reset the highlight whenever the filter changes (the list just changed).
  useEffect(() => {
    setSelectedIndex(0);
  }, [filter]);

  // Refs so the once-registered keydown handler always reads the latest values.
  const selectedIndexRef = useRef(0);
  selectedIndexRef.current = selectedIndex;
  const flatActionsRef = useRef(flatActions);
  flatActionsRef.current = flatActions;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Capture-phase keydown on window — fires before the engine's keydown handler
  // (bound on its hidden input element), so we claim Arrow/Enter/Escape for the
  // menu while letting every other key fall through to the editor (which types
  // the filter text). The plugin then recomputes the filter from the document.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          e.stopPropagation();
          setSelectedIndex((i) => {
            const len = flatActionsRef.current.length;
            return len === 0 ? 0 : Math.min(i + 1, len - 1);
          });
          break;
        case "ArrowUp":
          e.preventDefault();
          e.stopPropagation();
          setSelectedIndex((i) => Math.max(i - 1, 0));
          break;
        case "Enter": {
          const item = flatActionsRef.current[selectedIndexRef.current];
          if (!item) break;
          e.preventDefault();
          e.stopPropagation();
          onSelectRef.current(item);
          break;
        }
        case "Escape":
          e.preventDefault();
          e.stopPropagation();
          onCloseRef.current();
          break;
        case "ArrowLeft":
        case "ArrowRight":
          // Let the caret move (engine handles it); just dismiss the menu.
          onCloseRef.current();
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

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

import { cn } from "@/lib/utils";
import { renderToSVG } from "@cypherkit/editor";
import {
    Bold,
    Braces,
    Check,
    Code,
    Heading1,
    Heading2,
    Heading3,
    Image,
    IndentDecrease,
    IndentIncrease,
    Italic,
    List,
    ListChecks,
    ListOrdered,
    Minus,
    MoreHorizontal,
    Pilcrow,
    Quote,
    Redo2,
    Sigma,
    Strikethrough,
    Type,
    Undo2,
    X
} from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
    MobileToolbarAction,
    MobileToolbarIcon,
    MobileToolbarItem,
    MobileToolbarModel,
} from "../mobileToolbar";

const ICONS: Record<MobileToolbarIcon, React.ReactNode> = {
  undo: <Undo2 className="size-5" />,
  redo: <Redo2 className="size-5" />,
  bold: <Bold className="size-5" />,
  italic: <Italic className="size-5" />,
  code: <Code className="size-5" />,
  math_command: <Braces className="size-5" />,
  math: <Sigma className="size-5" />,
  strikethrough: <Strikethrough className="size-5" />,
  text: <Type className="size-5" />,
  paragraph: <Pilcrow className="size-5" />,
  heading1: <Heading1 className="size-5" />,
  heading2: <Heading2 className="size-5" />,
  heading3: <Heading3 className="size-5" />,
  quote: <Quote className="size-5" />,
  list: <List className="size-5" />,
  list_ordered: <ListOrdered className="size-5" />,
  list_todo: <ListChecks className="size-5" />,
  image: <Image className="size-5" />,
  line: <Minus className="size-5" />,
  indent: <IndentIncrease className="size-5" />,
  outdent: <IndentDecrease className="size-5" />,
  todo_check: <Check className="size-5" />,
  more: <MoreHorizontal className="size-5" />,
  keyboard_dismiss: <X className="size-5" />,
};

interface MobileKeyboardToolbarProps {
  model: MobileToolbarModel;
  onAction: (action: MobileToolbarAction) => void;
}

type MenuItem = Extract<MobileToolbarItem, { kind: "menu" }>;

// The bar is three zones: pinned non-scrolling ends and a single scrollable
// contextual middle. The model's `layout` already partitions the items; this
// component only renders them and owns the transient panels (block-type / code
// language menus, and the overflow "more" drawer) that open above the bar.
export function MobileKeyboardToolbar({
  model,
  onAction,
}: MobileKeyboardToolbarProps) {
  const { t } = useTranslation();
  const [openPanelId, setOpenPanelId] = useState<string | null>(null);
  const { layout } = model;

  const middle = layout.middle;
  const middleItems = middle.kind === "items" ? middle.items : [];

  // Menus can live in the left cluster or the middle; resolve the open one.
  const menus = [...layout.left, ...middleItems].filter(
    (item): item is MenuItem => item.kind === "menu",
  );
  const openMenu = menus.find((menu) => menu.id === openPanelId);
  const morePanelOpen = openPanelId === "more";
  // Light up the overflow trigger when one of its hidden controls is active,
  // mirroring an active inline mark on the visible bar.
  const moreActive = layout.more.some(
    (item) => item.kind === "button" && item.active,
  );

  // Pre-render each math chip's preview SVG. Keyed by query + chip ids so a
  // selection-only state tick (same row) doesn't re-render every preview.
  const mathChips = useMemo(() => {
    if (middle.kind !== "math") return [];
    return middle.chips.map((chip) => ({
      ...chip,
      svg: renderToSVG(chip.latex, false, 17),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    middle.kind,
    middle.kind === "math" ? middle.query : null,
    middle.kind === "math" ? middle.chips.map((c) => c.id).join(",") : "",
  ]);

  const togglePanel = (id: string) =>
    setOpenPanelId((current) => (current === id ? null : id));

  const renderItem = (item: MobileToolbarItem) => {
    if (item.kind === "divider") return <Divider key={item.id} />;
    if (item.kind === "spacer") return null;
    if (item.kind === "menu") {
      const open = openPanelId === item.id;
      return (
        <ToolbarButton
          key={item.id}
          onPress={() => {
            togglePanel(item.id);
          }}
          active={open}
          aria-label={item.label}
        >
          {ICONS[item.icon]}
        </ToolbarButton>
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
        {item.icon ? ICONS[item.icon] : null}
      </ToolbarButton>
    );
  };

  return (
    <div
      data-editor-overlay
      className="fixed bottom-0 left-0 right-0 z-50 flex flex-col"
      style={{ bottom: `${model.bottomInset}px` }}
      onTouchStart={(e) => e.stopPropagation()}
    >
      {/* Transient panel above the bar — a menu's options, or the more drawer. */}
      {openMenu && (
        <PanelRow>
          {openMenu.options.map((option) => (
            <PanelCell
              key={option.id}
              icon={option.icon}
              label={option.label}
              highlighted={openMenu.selected === option.id}
              onPress={() => {
                onAction(option.action);
                setOpenPanelId(null);
              }}
            />
          ))}
        </PanelRow>
      )}
      {morePanelOpen && layout.more.length > 0 && (
        <PanelRow>
          {layout.more.map((item) =>
            item.kind === "button" ? (
              <PanelCell
                key={item.id}
                icon={item.icon}
                label={item.label}
                highlighted={item.active}
                disabled={!item.enabled}
                onPress={() => {
                  onAction(item.action);
                  setOpenPanelId(null);
                }}
              />
            ) : null,
          )}
        </PanelRow>
      )}

      <div className="flex flex-row items-stretch border-t border-border bg-background h-12">
        <div className="flex shrink-0 flex-row items-center">
          {layout.left.map(renderItem)}
        </div>

        {/* Scrollable contextual middle. */}
        <div className="flex min-w-0 flex-1 flex-row items-center">
          {middle.kind === "math" ? (
            <MathRow
              query={middle.query}
              chips={mathChips}
              onInsert={(latex) =>
                onAction({ type: "insert-math-command", latex })
              }
            />
          ) : (
            <div className="flex min-w-0 flex-1 flex-row items-center touch-pan-x overflow-x-auto overscroll-x-contain no-scrollbar">
              {middleItems.map(renderItem)}
            </div>
          )}
        </div>

        <div className="flex shrink-0 flex-row items-center">
          {layout.more.length > 0 && (
            <>
              <ToolbarButton
                onPress={() => togglePanel("more")}
                active={morePanelOpen || moreActive}
                aria-label={t("editor.more", "More")}
              >
                {ICONS.more}
              </ToolbarButton>
              <Divider />
            </>
          )}
          {layout.right.map(renderItem)}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface MathRowProps {
  query: string | null;
  chips: Array<{ id: string; name: string; latex: string; svg: string }>;
  onInsert: (latex: string) => void;
}

// The contextual math row: a pinned `\`-query prefix (live state), the matching
// construct chips (rendered as glyph previews), or a clear "no match" when a
// typed command resolves to nothing rather than a blank gap.
function MathRow({ query, chips, onInsert }: MathRowProps) {
  const { t } = useTranslation();
  return (
    <>
      {chips.length > 0 ? (
        <div className="flex min-w-0 flex-1 flex-row items-center touch-pan-x overflow-x-auto overscroll-x-contain no-scrollbar">
          {chips.map((chip, index) => (
            <button
              key={chip.id}
              onMouseDown={(e) => {
                // Keep the editor focused (and don't cancel Android's touch-pan
                // gesture on the horizontal scroller).
                e.preventDefault();
              }}
              onClick={(e) => {
                e.preventDefault();
                onInsert(chip.latex);
              }}
              aria-label={t("editor.math.insertConstruct", "Insert {{name}}", {
                name: chip.name,
              })}
              className={cn(
                "mx-0.5 flex h-9 min-w-[44px] shrink-0 items-center justify-center rounded-md px-2.5 transition-colors active:bg-muted",
                "[&>svg]:h-auto [&>svg]:max-h-6 [&>svg]:w-auto [&>svg]:max-w-[72px]",
                // In the live state the leftmost chip is the top match — the
                // closest completion of the typed `\command`.
                query !== null && index === 0
                  ? "bg-accent text-foreground ring-1 ring-inset ring-primary/40"
                  : "text-foreground",
              )}
              dangerouslySetInnerHTML={{ __html: chip.svg }}
            />
          ))}
        </div>
      ) : (
        <span className="min-w-0 flex-1 truncate px-3 text-sm text-muted-foreground">
          {t("editor.math.noConstructs", "No matching constructs")}
        </span>
      )}
    </>
  );
}

function PanelRow({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex w-full min-w-0 flex-row touch-pan-x overflow-x-auto overscroll-x-contain border-t border-border bg-background px-2 py-1.5 gap-1 no-scrollbar">
      {children}
    </div>
  );
}

interface PanelCellProps {
  icon?: MobileToolbarIcon;
  label: string;
  highlighted?: boolean;
  disabled?: boolean;
  onPress: () => void;
}

function PanelCell({
  icon,
  label,
  highlighted = false,
  disabled = false,
  onPress,
}: PanelCellProps) {
  return (
    <button
      onMouseDown={(e) => {
        // Preserve editor focus without cancelling the row's touch-pan scroll.
        e.preventDefault();
      }}
      onClick={(e) => {
        e.preventDefault();
        if (!disabled) onPress();
      }}
      disabled={disabled}
      className={cn(
        "flex shrink-0 flex-col items-center justify-center gap-0.5 rounded-md px-3 py-2 min-w-[52px] transition-colors",
        highlighted
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground active:bg-muted",
        disabled && "opacity-30",
      )}
    >
      {icon && ICONS[icon]}
      <span className="text-[10px] leading-none whitespace-nowrap">
        {label}
      </span>
    </button>
  );
}

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

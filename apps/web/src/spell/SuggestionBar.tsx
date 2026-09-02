import { BookPlus, EyeOff, X } from "lucide-react";
import React, {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import type { FlagRef } from "@tasfer/spell";
import { cn } from "@/lib/utils";

/**
 * The touch suggestion strip: `[s1] [s2] [s3] [Add] [Ignore] [×]`, docked in
 * the mobile keyboard toolbar while the caret sits in a misspelled word after
 * a tap. The layer owns when it shows; this only renders it.
 */
export interface SuggestionBarProps {
  flag: FlagRef;
  /** `null` while the lookup is in flight. */
  suggestions: string[] | null;
  onApply(suggestion: string): void;
  onAdd(): void;
  onIgnore(): void;
  onDismiss(): void;
}

const MAX_CHIPS = 3;

export function SuggestionBar({
  flag,
  suggestions,
  onApply,
  onAdd,
  onIgnore,
  onDismiss,
}: SuggestionBarProps) {
  const { t } = useTranslation();
  const chips = suggestions?.slice(0, MAX_CHIPS) ?? [];
  return (
    <div
      role="group"
      aria-label={t("spell.bar.label", "Spelling suggestions for {{word}}", {
        word: flag.word,
      })}
      className="flex w-full min-w-0 flex-row items-center gap-1 border-t border-border bg-background px-2 py-1.5"
    >
      <div className="flex min-w-0 flex-1 flex-row items-center gap-1 touch-pan-x overflow-x-auto overscroll-x-contain no-scrollbar">
        {suggestions === null ? (
          <span className="truncate px-2 text-sm text-muted-foreground">
            {t("spell.bar.lookingUp", "Looking up…")}
          </span>
        ) : chips.length === 0 ? (
          <span className="truncate px-2 text-sm text-muted-foreground">
            {t("spell.bar.noSuggestions", "No suggestions")}
          </span>
        ) : (
          chips.map((s, i) => (
            <BarButton
              key={`${i}:${s}`}
              onPress={() => onApply(s)}
              className={cn(
                "min-w-[44px] px-3 font-medium text-foreground",
                i === 0 && "bg-accent ring-1 ring-inset ring-primary/40",
              )}
            >
              <span dir="auto">{s}</span>
            </BarButton>
          ))
        )}
      </div>
      <div className="flex shrink-0 flex-row items-center gap-1">
        <BarButton onPress={onAdd} className="px-2.5 text-muted-foreground">
          <BookPlus className="size-4" aria-hidden />
          <span>{t("spell.bar.add", "Add")}</span>
        </BarButton>
        <BarButton onPress={onIgnore} className="px-2.5 text-muted-foreground">
          <EyeOff className="size-4" aria-hidden />
          <span>{t("spell.bar.ignore", "Ignore")}</span>
        </BarButton>
        <BarButton
          onPress={onDismiss}
          className="w-9 px-0 text-muted-foreground"
          aria-label={t("spell.bar.dismiss", "Dismiss")}
        >
          <X className="size-4" aria-hidden />
        </BarButton>
      </div>
    </div>
  );
}

interface BarButtonProps {
  onPress: () => void;
  className?: string;
  children: ReactNode;
  "aria-label"?: string;
}

function BarButton({ onPress, className, children, ...rest }: BarButtonProps) {
  return (
    <button
      type="button"
      onMouseDown={(e) => {
        // Keep the editor's hidden input focused (and the keyboard up); a
        // mousedown guard, not pointerdown, so the row's touch-pan survives.
        e.preventDefault();
      }}
      onClick={(e) => {
        e.preventDefault();
        onPress();
      }}
      className={cn(
        "flex h-9 shrink-0 flex-row items-center justify-center gap-1.5 rounded-md text-sm transition-colors active:bg-muted",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

// ── The toolbar slot ────────────────────────────────────────────────────────
//
// The bar is owned by `SpellcheckLayer` (portaled into the editor's overlay
// container) but has to render inside `MobileKeyboardToolbar`, a sibling in
// the host's tree. This context carries the rendered node across: the layer
// sets it, the toolbar's `<SuggestionBarSlot>` renders it. Per host instance
// (a provider around each mounted editor), never module state.

interface SuggestionBarSlotValue {
  content: ReactNode;
  setContent: (node: ReactNode) => void;
}

const SuggestionBarSlotContext = createContext<SuggestionBarSlotValue | null>(
  null,
);

export function SuggestionBarSlotProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [content, setContent] = useState<ReactNode>(null);
  const value = useMemo(() => ({ content, setContent }), [content]);
  return (
    <SuggestionBarSlotContext.Provider value={value}>
      {children}
    </SuggestionBarSlotContext.Provider>
  );
}

/** The layer's handle on the slot; `null` outside a provider (readonly hosts). */
export function useSuggestionBarSlot(): SuggestionBarSlotValue | null {
  return useContext(SuggestionBarSlotContext);
}

/** Renders whatever the layer docked; mount it inside the keyboard toolbar. */
export function SuggestionBarSlot(): React.ReactElement | null {
  const slot = useContext(SuggestionBarSlotContext);
  if (!slot?.content) return null;
  return <>{slot.content}</>;
}

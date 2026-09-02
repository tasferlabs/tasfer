import * as Popover from "@radix-ui/react-popover";
import { BookPlus, EyeOff } from "lucide-react";
import React, { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { FlagRef } from "@tasfer/spell";
import { cn } from "@/lib/utils";

/**
 * Desktop suggestion popover under a misspelled word.
 *
 * Focus never leaves the editor's hidden input: the list is walked with a
 * capture-phase keydown (the `SlashActionMenu` / `ContextMenu` pattern) and
 * only the keys the popover owns are swallowed — everything else closes it and
 * reaches the editor, so a fast typist is never trapped.
 */
export interface SuggestionPopoverProps {
  flag: FlagRef;
  /** `null` while the lookup is in flight. */
  suggestions: string[] | null;
  /** Viewport coordinates of the word's visual start / bottom edge. */
  x: number;
  y: number;
  onApply(suggestion: string): void;
  onAdd(): void;
  onIgnore(): void;
  onClose(): void;
  /** Reports the highlighted suggestion (for the live region). */
  onActiveChange?(suggestion: string | null): void;
  container?: HTMLElement | null;
  /** Words ignored on this page; shows the footer with Clear when > 0. */
  ignoredCount?: number;
  onClearIgnored?(): void;
}

const MAX_SUGGESTIONS = 5;
/** Keys that only change modifier state; they neither act nor dismiss. */
const MODIFIER_KEYS = new Set([
  "Shift",
  "Meta",
  "Control",
  "Alt",
  "CapsLock",
  "AltGraph",
  "Fn",
]);

export function SuggestionPopover({
  flag,
  suggestions,
  x,
  y,
  onApply,
  onAdd,
  onIgnore,
  onClose,
  onActiveChange,
  container,
  ignoredCount = 0,
  onClearIgnored,
}: SuggestionPopoverProps) {
  const { t } = useTranslation();
  const listId = useId();
  const rows = suggestions?.slice(0, MAX_SUGGESTIONS) ?? [];
  const [activeIndex, setActiveIndex] = useState(0);

  // Reset the highlight when the word (or its list) changes.
  const movedRef = useRef(false);
  useEffect(() => {
    setActiveIndex(0);
    movedRef.current = false;
  }, [flag, suggestions]);

  // Announce the highlighted row only once the person moves it — the opening
  // announcement ("word: misspelled, n suggestions") must not be overwritten.
  useEffect(() => {
    if (!movedRef.current) return;
    onActiveChange?.(rows[activeIndex] ?? null);
    // Only the highlighted row matters here, not the callback identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIndex, rows[activeIndex]]);

  // Refs so the once-registered listener reads the latest values.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const activeRef = useRef(activeIndex);
  activeRef.current = activeIndex;
  const handlersRef = useRef({ onApply, onAdd, onIgnore, onClose });
  handlersRef.current = { onApply, onAdd, onIgnore, onClose };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (MODIFIER_KEYS.has(e.key)) return;
      const h = handlersRef.current;
      const list = rowsRef.current;
      const swallow = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      const hasChord = e.metaKey || e.ctrlKey || e.altKey;

      if (!hasChord) {
        switch (e.key) {
          case "ArrowDown":
          case "ArrowUp": {
            if (list.length === 0) return;
            swallow();
            movedRef.current = true;
            const delta = e.key === "ArrowDown" ? 1 : -1;
            setActiveIndex((i) => (i + delta + list.length) % list.length);
            return;
          }
          case "Enter":
          case "Tab": {
            // With nothing to apply, Enter/Tab just dismiss: letting them
            // through would split or indent the selected word.
            swallow();
            const pick = list[activeRef.current];
            if (pick !== undefined) h.onApply(pick);
            else h.onClose();
            return;
          }
          case "Escape":
            swallow();
            h.onClose();
            return;
        }
        // Mnemonics and digits on `code`, so non-Latin layouts work too.
        if (e.code === "KeyA" && !e.shiftKey) {
          swallow();
          h.onAdd();
          return;
        }
        if (e.code === "KeyI" && !e.shiftKey) {
          swallow();
          h.onIgnore();
          return;
        }
        const digit = /^Digit([1-5])$/.exec(e.code);
        if (digit && !e.shiftKey) {
          const pick = list[Number(digit[1]) - 1];
          if (pick !== undefined) {
            swallow();
            h.onApply(pick);
            return;
          }
        }
      }
      // Anything else: close and let the editor have the key.
      h.onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  const optionId = (i: number) => `${listId}-opt-${i}`;

  return (
    <Popover.Root open onOpenChange={(open) => !open && onClose()}>
      <Popover.Anchor
        style={{ position: "fixed", left: x, top: y, width: 1, height: 1 }}
      />
      <Popover.Portal container={container ?? undefined}>
        <Popover.Content
          data-editor-overlay=""
          className="bg-popover/95 backdrop-blur-xl rounded-xl border border-border/60 p-1.5 min-w-[200px] max-w-[320px] z-50 select-none pointer-events-auto animate-in fade-in zoom-in-95 duration-100"
          style={{
            boxShadow:
              "0 0 0 0.5px rgba(0,0,0,0.03), 0 2px 4px rgba(0,0,0,0.04), 0 8px 24px rgba(0,0,0,0.1), 0 24px 48px rgba(0,0,0,0.06)",
          }}
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={10}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          onMouseDown={(e) => e.preventDefault()}
        >
          <div className="px-2.5 pt-1 pb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
            {t("spell.popover.title", "Suggestions")}
          </div>
          <div
            role="listbox"
            id={listId}
            aria-label={t("spell.popover.misspelled", "Misspelled: {{word}}", {
              word: flag.word,
            })}
            aria-activedescendant={
              rows.length > 0 ? optionId(activeIndex) : undefined
            }
          >
            {suggestions === null ? (
              <div
                className="px-2.5 py-[7px] text-[13px] text-muted-foreground"
                aria-busy="true"
              >
                {t("spell.popover.lookingUp", "Looking up…")}
              </div>
            ) : rows.length === 0 ? (
              <div className="px-2.5 py-[7px] text-[13px] text-muted-foreground">
                {t("spell.popover.noSuggestions", "No suggestions")}
              </div>
            ) : (
              rows.map((s, i) => {
                const active = i === activeIndex;
                return (
                  <button
                    key={`${i}:${s}`}
                    type="button"
                    role="option"
                    id={optionId(i)}
                    aria-selected={active}
                    className={cn(
                      "w-full px-2.5 py-[7px] flex items-center gap-2.5 rounded-[9px] text-[13px] font-medium transition-colors duration-75",
                      active
                        ? "bg-accent text-accent-foreground"
                        : "text-popover-foreground hover:bg-accent hover:text-accent-foreground",
                    )}
                    onMouseEnter={() => setActiveIndex(i)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => onApply(s)}
                  >
                    <span className="flex-1 text-start" dir="auto">
                      {s}
                    </span>
                    <kbd className="text-[10px] text-muted-foreground/70">
                      {i + 1}
                    </kbd>
                  </button>
                );
              })
            )}
          </div>
          <div className="my-1 h-px bg-border/60" />
          <ActionRow
            icon={<BookPlus size={14} />}
            label={t("spell.popover.add", "Add to dictionary")}
            hint="A"
            onPress={onAdd}
          />
          <ActionRow
            icon={<EyeOff size={14} />}
            label={t("spell.popover.ignore", "Ignore")}
            hint="I"
            onPress={onIgnore}
          />
          {ignoredCount > 0 && onClearIgnored && (
            <div className="mt-1 flex items-center justify-between gap-2 border-t border-border/60 px-2.5 pt-1.5 pb-0.5 text-[11px] text-muted-foreground">
              <span>
                {t("spell.popover.ignoredCount", {
                  count: ignoredCount,
                  defaultValue_one: "{{count}} word ignored on this page",
                  defaultValue_other: "{{count}} words ignored on this page",
                })}
              </span>
              <button
                type="button"
                className="shrink-0 underline hover:text-foreground"
                onMouseDown={(e) => e.preventDefault()}
                onClick={onClearIgnored}
              >
                {t("spell.popover.clearIgnored", "Clear")}
              </button>
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function ActionRow({
  icon,
  label,
  hint,
  onPress,
}: {
  icon: React.ReactNode;
  label: string;
  hint: string;
  onPress: () => void;
}) {
  return (
    <button
      type="button"
      className="w-full px-2.5 py-[7px] flex items-center gap-2.5 rounded-[9px] text-[13px] font-medium text-popover-foreground transition-colors duration-75 hover:bg-accent hover:text-accent-foreground"
      onMouseDown={(e) => e.preventDefault()}
      onClick={onPress}
    >
      <span className="w-4 h-4 flex items-center justify-center shrink-0 text-muted-foreground">
        {icon}
      </span>
      <span className="flex-1 text-start">{label}</span>
      {/* Keyboard mnemonic — a key name, drawn LTR in every UI language. */}
      <kbd
        dir="ltr"
        className="rounded border border-border bg-muted px-1 text-[10px] leading-none text-muted-foreground"
      >
        {hint}
      </kbd>
    </button>
  );
}

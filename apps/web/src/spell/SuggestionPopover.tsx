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
  /** Reports the highlighted row's label (for the live region). */
  onActiveChange?(label: string | null): void;
  container?: HTMLElement | null;
  /** Words ignored on this page; shows the footer with Clear when > 0. */
  ignoredCount?: number;
  onClearIgnored?(): void;
}

const MAX_SUGGESTIONS = 5;
/** No row highlighted — Enter dismisses instead of activating something. */
const NO_ACTIVE = -1;

/** A row the arrows can land on: a suggestion, or one of the actions. */
interface PopoverItem {
  key: string;
  label: string;
  run(): void;
}

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

  // One walkable list: the suggestions, then the actions. The arrows treat the
  // menu as a whole, so "Add to dictionary" is reachable past the last word.
  const items: PopoverItem[] = [
    ...rows.map((s) => ({ key: `s:${s}`, label: s, run: () => onApply(s) })),
    {
      key: "add",
      label: t("spell.popover.add", "Add to dictionary"),
      run: onAdd,
    },
    { key: "ignore", label: t("spell.popover.ignore", "Ignore"), run: onIgnore },
  ];
  // Without a suggestion to take, nothing starts highlighted: Enter should
  // dismiss rather than commit the word to the dictionary by surprise.
  const initialIndex = rows.length > 0 ? 0 : NO_ACTIVE;
  const [activeIndex, setActiveIndex] = useState(initialIndex);

  // Reset the highlight when the word (or its list) changes.
  const movedRef = useRef(false);
  useEffect(() => {
    setActiveIndex(initialIndex);
    movedRef.current = false;
  }, [flag, suggestions, initialIndex]);

  // Announce the highlighted row only once the person moves it — the opening
  // announcement ("word: misspelled, n suggestions") must not be overwritten.
  useEffect(() => {
    if (!movedRef.current) return;
    onActiveChange?.(items[activeIndex]?.label ?? null);
    // Only the highlighted row matters here, not the callback identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIndex, items[activeIndex]?.label]);

  // Refs so the once-registered listener reads the latest values.
  const itemsRef = useRef(items);
  itemsRef.current = items;
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
      const list = itemsRef.current;
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
            const down = e.key === "ArrowDown";
            setActiveIndex((i) =>
              i === NO_ACTIVE
                ? down
                  ? 0
                  : list.length - 1
                : (i + (down ? 1 : -1) + list.length) % list.length,
            );
            return;
          }
          case "Enter":
          case "Tab": {
            // With nothing highlighted, Enter/Tab just dismiss: letting them
            // through would split or indent the selected word.
            swallow();
            const pick = list[activeRef.current];
            if (pick) pick.run();
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
          const pick = rowsRef.current[Number(digit[1]) - 1];
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
          <div
            role="listbox"
            id={listId}
            aria-label={t("spell.popover.misspelled", "Misspelled: {{word}}", {
              word: flag.word,
            })}
            aria-activedescendant={
              activeIndex === NO_ACTIVE ? undefined : optionId(activeIndex)
            }
          >
            <div
              role="presentation"
              className="px-2.5 pt-1 pb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70"
            >
              {t("spell.popover.title", "Suggestions")}
            </div>
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
            <div role="presentation" className="my-1 h-px bg-border/60" />
            {ACTIONS.map(({ icon, hint }, n) => {
              const i = rows.length + n;
              const item = items[i];
              return (
                <ActionRow
                  key={item.key}
                  id={optionId(i)}
                  icon={icon}
                  label={item.label}
                  hint={hint}
                  active={i === activeIndex}
                  onHover={() => setActiveIndex(i)}
                  onPress={item.run}
                />
              );
            })}
          </div>
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

/**
 * Icon and mnemonic per action row; the label and handler come from `items`.
 * The mnemonics print lowercase because they are bare keypresses — an
 * uppercase cap would read as Shift, which the handler in fact rejects.
 */
const ACTIONS = [
  { icon: <BookPlus size={14} />, hint: "a" },
  { icon: <EyeOff size={14} />, hint: "i" },
] as const;

function ActionRow({
  id,
  icon,
  label,
  hint,
  active,
  onHover,
  onPress,
}: {
  id: string;
  icon: React.ReactNode;
  label: string;
  hint: string;
  active: boolean;
  onHover: () => void;
  onPress: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      id={id}
      aria-selected={active}
      className={cn(
        "w-full px-2.5 py-[7px] flex items-center gap-2.5 rounded-[9px] text-[13px] font-medium transition-colors duration-75",
        active
          ? "bg-accent text-accent-foreground"
          : "text-popover-foreground hover:bg-accent hover:text-accent-foreground",
      )}
      onMouseEnter={onHover}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onPress}
    >
      <span
        className={cn(
          "w-4 h-4 flex items-center justify-center shrink-0",
          active ? "text-accent-foreground" : "text-muted-foreground",
        )}
      >
        {icon}
      </span>
      <span className="flex-1 text-start">{label}</span>
      {/* Keyboard mnemonic — a key name, drawn LTR in every UI language. */}
      <kbd
        dir="ltr"
        className={cn(
          "rounded border border-border px-1 text-[10px] leading-none",
          active
            ? "bg-accent-foreground/10 text-accent-foreground"
            : "bg-muted text-muted-foreground",
        )}
      >
        {hint}
      </kbd>
    </button>
  );
}

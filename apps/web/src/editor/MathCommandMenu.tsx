import * as Popover from "@radix-ui/react-popover";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import { TEXT_INPUT } from "@tasfer/editor";
import { isTouchOnlyDevice } from "@tasfer/editor/internal";
import {
  INSERT_MATH_COMMAND,
  type MathCommand,
  mathCommandInsertion,
  renderToSVG,
} from "@tasfer/editor/math";
import {
  mathElementLabel,
  type MathMenuMode,
  type MathMenuTrigger,
  searchMathCommands,
} from "./mathCommandSearch";
import { activeTreeMath, treeMathCommandRun } from "./treeMath";
import {
  type KeyboardMenuInputSource,
  shouldOpenKeyboardMenu,
} from "./keyboardMenuInput";
import useResponsive from "../app/hooks/useResponsive";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "../components/ui/drawer";
import { Input } from "../components/ui/input";
import { ScrollArea } from "../components/ui/scroll-area";
import type { AppEditor } from "../editorSchema";

interface MathCommandMenuProps {
  /** The editor this menu observes for `\` input inside a math chip. */
  editor: AppEditor;
  /** The editor surface's viewport rect, for translating caret coords to screen. */
  getContainerRect: () => DOMRect | null | undefined;
}

/** The `\`-trigger run we're tracking: the block + the identity of the `\`. */
interface Trigger {
  blockId: string;
  mode: MathMenuMode;
  trigger: MathMenuTrigger;
  /** Flat path: index of the trigger in the block text. -1 on the tree path. */
  triggerIndex: number;
  /** Tree path: stable trigger identity, latched on first recompute. */
  triggerCharId?: string;
  inputSource?: KeyboardMenuInputSource;
}

/**
 * Math `\` command menu — a Corca-style autocomplete that pops up when you type
 * `\` inside a math context: a **block** equation OR an **inline** math chip
 * (edited in place on the canvas — no mirror popover). Self-contained host chrome
 * (the engine has no notion of it): it observes {@link TEXT_INPUT} to edge-trigger
 * on a `\`, recomputes the query/anchor from editor state on every change, renders
 * each candidate as live math (via {@link renderToSVG} — empty `{}` slots show as
 * faint placeholder boxes), and on select replaces the typed `\query` with the
 * construct and drops the caret in its first slot. Renders nothing while closed.
 *
 * The two contexts share everything: the `\query` run, its replacement on select
 * (an interior `insertText` that keeps a chip a single well-anchored span), and
 * the anchor (`coordsAtPos` at the `\`). They differ only in the gate below —
 * a block equation is the whole block's LaTeX, whereas a chip is a math-mark span
 * the `\` must sit strictly inside.
 */
export const MathCommandMenu: React.FC<MathCommandMenuProps> = ({
  editor,
  getContainerRect,
}) => {
  const useDrawer = useResponsive("(pointer: coarse)");
  // Open trigger lives in a ref (set synchronously inside the TEXT_INPUT handler,
  // before the `\` commits) so the next `subscribe` tick computes the anchor.
  const triggerRef = useRef<Trigger | null>(null);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    query: string;
    mode: MathMenuMode;
    inputSource?: KeyboardMenuInputSource;
  } | null>(null);

  const close = React.useCallback(() => {
    triggerRef.current = null;
    setMenu(null);
  }, []);

  const select = React.useCallback(
    (cmd: MathCommand) => {
      const t = triggerRef.current;
      const tree = activeTreeMath(editor);
      if (t && tree?.blockId === t.blockId) {
        const following = tree.source[tree.sourceOffset] ?? "";
        const insertion = mathCommandInsertion(cmd.latex, following);
        editor.dispatch(INSERT_MATH_COMMAND, {
          text: insertion.text,
          caretOffset: insertion.caretOffset,
          trigger: t.trigger,
        });
        close();
        return;
      }
      const range = editor.state.selection.range;
      const caretIndex =
        range && typeof range === "object" && "offset" in range
          ? (range.offset ?? 0)
          : null;
      if (!t || caretIndex === null) return;
      // For an inline chip, capture its span before the edit so we can keep the
      // construct inside the math mark below. A block equation has no such mark
      // (its whole text IS the LaTeX), so `chip` stays undefined there.
      const block = editor.query.block({
        block: t.blockId,
        offset: t.triggerIndex,
      });
      // A display equation may still be carrying legacy compatibility text
      // until its first edit. Send command commits through the structural
      // action even in that state: the math extension owns lazy migration and
      // can replace the trailing `\\query` without exposing command characters
      // to the generic range editor.
      if (block?.type === "math") {
        const following = block.text[caretIndex] ?? "";
        const insertion = mathCommandInsertion(cmd.latex, following);
        editor.dispatch(INSERT_MATH_COMMAND, {
          text: insertion.text,
          caretOffset: insertion.caretOffset,
          trigger: t.trigger,
        });
        close();
        return;
      }
      const chip = block
        ? editor.query
            .marks({ block: t.blockId, offset: t.triggerIndex })
            .find((m) => m.name === "math")
        : undefined;
      // The formula character right after the replaced run — the rest of the
      // block for an equation, but only up to the chip's end for inline math
      // (text past the chip is prose, which can't fuse with a command). A
      // letter there needs a separator space or committing `\pi` in `a\pi|a`
      // leaves the fused unknown `\pia`; `mathCommandInsertion` appends it.
      const following =
        chip && caretIndex < chip.to ? (block?.text[caretIndex] ?? "") : "";
      const insertion = mathCommandInsertion(cmd.latex, following);
      // Replace the typed "\query" with the construct (one undo step).
      editor.change((c) => {
        c.insertText(insertion.text, {
          from: { block: t.blockId, offset: t.triggerIndex },
          to: { block: t.blockId, offset: caretIndex },
        });
        // Inline chip: the construct is covered positionally when it lands strictly
        // inside the span, but replacing `[backslash, caret)` when the `\` was the
        // chip's FIRST char drops the span's start anchor — orphaning the construct
        // outside the math mark. Re-mark the whole resulting formula so it stays ONE
        // well-anchored chip. Offsets are post-insert (each queued edit resolves
        // against the running state): the formula start is unchanged, its end shifts
        // by the length delta. Idempotent when coverage was already intact, so it's
        // safe for the interior/edge cases too.
        if (chip) {
          const end =
            chip.to + insertion.text.length - (caretIndex - t.triggerIndex);
          c.setMark("math", {
            active: true,
            range: {
              from: { block: t.blockId, offset: chip.from },
              to: { block: t.blockId, offset: end },
            },
          });
        }
        c.select({
          block: t.blockId,
          offset: t.triggerIndex + insertion.caretOffset,
        });
      });
      close();
    },
    [editor, close],
  );

  useEffect(() => {
    const recompute = () => {
      const t = triggerRef.current;
      if (!t) return;
      const tree = activeTreeMath(editor);

      // Tree path — block equations AND structured inline chips. The query is
      // read from the raw-text field at the caret, never sliced out of the
      // projected source: the projection is allowed to diverge from what was
      // typed (a pending lone `\` projects as `\backslash`). The run is
      // tracked by the trigger's stable identity, latched on the first tick
      // after the keystroke, so the menu closes exactly when that trigger
      // stops being the run the caret is completing.
      if (tree) {
        const run =
          tree.blockId === t.blockId
            ? treeMathCommandRun(tree, t.trigger)
            : null;
        if (
          !run ||
          (t.triggerCharId && run.triggerCharId !== t.triggerCharId)
        ) {
          return close();
        }
        if (!t.triggerCharId) {
          triggerRef.current = { ...t, triggerCharId: run.triggerCharId };
        }
        const coords = editor.view.coordsAtContent(
          run.anchor?.focus ?? tree.point,
        );
        const rect = getContainerRect();
        if (!coords || !rect) return;
        const x = rect.left + coords.x;
        const y = rect.top + coords.y + coords.height;
        setMenu((prev) =>
          prev &&
          prev.x === x &&
          prev.y === y &&
          prev.query === run.query &&
          prev.mode === t.mode &&
          prev.inputSource === t.inputSource
            ? prev
            : {
                x,
                y,
                query: run.query,
                mode: t.mode,
                inputSource: t.inputSource,
              },
        );
        return;
      }

      // Flat path — inline chips still edited as flat marked text.
      const range = editor.state.selection.range;
      const flatPoint =
        range && typeof range === "object" && "offset" in range ? range : null;
      if (!flatPoint) return close();
      const block = editor.query.block(flatPoint);
      if (!block) return close();

      const text = block.text;
      const caretIndex = flatPoint.offset ?? 0;
      // Close when the caret leaves the trigger run or the trigger is deleted.
      if (
        block.id !== t.blockId ||
        t.triggerIndex < 0 ||
        caretIndex <= t.triggerIndex ||
        text[t.triggerIndex] !== t.trigger
      ) {
        return close();
      }
      // The `\` run must be in a math context. A block equation qualifies whole
      // (its text IS the LaTeX). Otherwise the `\` must sit inside an inline math
      // chip (a "math" mark run) with the caret still within it. The `\` MAY be the
      // chip's first char — starting a formula with a command (`\frac`, …) — since
      // `select` re-marks the inserted construct so replacing the span's start
      // anchor doesn't orphan it. Query at the backslash (always inside the run)
      // rather than the caret, whose right edge is exclusive.
      if (block.type !== "math") {
        const chip = editor.query
          .marks({ block: block.id, offset: t.triggerIndex })
          .find((m) => m.name === "math");
        if (!chip || caretIndex > chip.to) {
          return close();
        }
      }

      const query = text.slice(t.triggerIndex + 1, caretIndex);
      const validQuery = t.mode === "latex" ? /^[a-zA-Z]*$/ : /^\p{L}*$/u;
      if (!validQuery.test(query)) return close();

      const coords = editor.view.coordsAtPos({
        block: block.id,
        offset: t.triggerIndex,
      });
      const rect = getContainerRect();
      if (!coords || !rect) return;
      const x = rect.left + coords.x;
      const y = rect.top + coords.y + coords.height;
      setMenu((prev) =>
        prev &&
        prev.x === x &&
        prev.y === y &&
        prev.query === query &&
        prev.mode === t.mode &&
        prev.inputSource === t.inputSource
          ? prev
          : { x, y, query, mode: t.mode, inputSource: t.inputSource },
      );
    };

    // Edge-trigger `\` for LaTeX and `/` for the name-first construct menu.
    // The trigger isn't committed yet, so the
    // anchor/query — and the math-context gate (block equation vs. inside an
    // inline chip) — are decided in `recompute` on the next `subscribe` tick,
    // which closes again immediately for a `\` typed in plain prose. A
    // touch-first device opens this only for a connected physical keyboard.
    //
    // `/` arms at ANY offset, not just after a boundary: math has no spaces, so
    // a boundary rule would confine the menu to a formula's first character,
    // and constructs legitimately follow an operand (`a` → `\times`). The `/`
    // stays plain division text throughout — the menu is a lens over it that
    // dismisses itself once the query matches nothing, so `a/b` types through
    // untouched.
    const offInput = editor.registerAction(
      TEXT_INPUT,
      ({ text, textIndex, contentPoint, inputSource }) => {
        const trigger = text === "\\" || text === "/" ? text : null;
        if (
          !trigger ||
          !shouldOpenKeyboardMenu(isTouchOnlyDevice(), inputSource)
        ) {
          return;
        }
        // The `\` was just typed at the caret, so the caret block IS the trigger
        // block; `recompute` validates the math context.
        const block = contentPoint
          ? editor.query.block({ block: contentPoint.blockId })
          : editor.query.block();
        if (!block) return;
        triggerRef.current = {
          blockId: block.id,
          mode: trigger === "/" ? "names" : "latex",
          trigger,
          triggerIndex: contentPoint ? -1 : textIndex,
          inputSource,
        };
      },
    );
    const offSub = editor.subscribe(recompute);
    return () => {
      offInput();
      offSub();
    };
  }, [editor, getContainerRect, close]);

  if (!menu) return null;
  if (useDrawer && menu.inputSource !== "hardware-keyboard") {
    return (
      <MathCommandDrawer
        query={menu.query}
        mode={menu.mode}
        onSelect={select}
        onClose={() => {
          close();
          editor.focus();
        }}
      />
    );
  }
  return (
    <MathCommandList
      x={menu.x}
      y={menu.y}
      query={menu.query}
      mode={menu.mode}
      onSelect={select}
      onClose={close}
    />
  );
};

interface MathCommandListProps {
  x: number;
  y: number;
  query: string;
  mode: MathMenuMode;
  onSelect: (cmd: MathCommand) => void;
  onClose: () => void;
}

const MathCommandList: React.FC<MathCommandListProps> = ({
  x,
  y,
  query,
  mode,
  onSelect,
  onClose,
}) => {
  const maxHeight = useMemo(() => {
    const viewportHeight =
      typeof window !== "undefined" ? window.innerHeight : 800;
    const available = viewportHeight - y - 20 - 5;
    return Math.max(180, Math.min(420, available));
  }, [y]);

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
          className="z-50 select-none"
          side="bottom"
          align="start"
          sideOffset={6}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <MathCommandPalette
            query={query}
            mode={mode}
            onSelect={onSelect}
            onClose={onClose}
            maxHeight={maxHeight}
            className="bg-popover rounded-xl shadow-xl border border-border/50 min-w-[340px] max-w-[420px] overflow-hidden"
          />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
};

interface MathCommandPaletteProps {
  query: string;
  mode?: MathMenuMode;
  onSelect: (cmd: MathCommand) => void;
  /** Dismiss the palette (Escape / no match / caret left the `\` run). */
  onClose: () => void;
  /** Max scroll height of the list, px. */
  maxHeight: number;
  /**
   * Styling for the list's root container. The floating menu supplies the full
   * popover box; the docked overlay supplies a separator instead (its parent is
   * already the box).
   */
  className?: string;
  /** Whether an unmatched query dismisses the surrounding surface. */
  autoCloseOnEmpty?: boolean;
  /** Content shown when an unmatched query has no results. */
  emptyState?: React.ReactNode;
  /** Whether this palette owns global arrow/Enter/Escape navigation. */
  captureKeyboardNavigation?: boolean;
}

/**
 * The `\`-command list itself — filtering, keyboard nav (Arrow to move,
 * Enter/Tab to select, Escape/←→ to dismiss), live-math previews, and
 * auto-dismiss when nothing matches. Presentational and position-free, so it
 * renders both as the floating block-equation menu (wrapped in a Popover by
 * {@link MathCommandList}) and docked inside the inline-math WYSIWYG overlay.
 * Renders nothing when no command matches the query.
 */
export const MathCommandPalette: React.FC<MathCommandPaletteProps> = ({
  query,
  mode = "latex",
  onSelect,
  onClose,
  maxHeight,
  className,
  autoCloseOnEmpty = true,
  emptyState = null,
  captureKeyboardNavigation = true,
}) => {
  const selectedRef = useRef<HTMLButtonElement>(null);
  const { t } = useTranslation();

  // Filter + pre-render each candidate's preview SVG (cheap, but memoized so
  // typing a letter doesn't re-render every row's math from scratch).
  const items = useMemo(() => {
    const translate = (key: string, fallback: string) => t(key, fallback);
    return searchMathCommands(query, mode, translate).map((cmd) => ({
      cmd,
      svg: renderToSVG(cmd.latex, false, 19),
      label:
        mode === "latex" ? `\\${cmd.id}` : mathElementLabel(cmd, translate),
    }));
  }, [mode, query, t]);

  // `/` is also plain division, so nothing is preselected while its query is
  // still empty (-1 = no row): Enter falls through to the editor instead of
  // committing a construct. An arrow key or the first typed letter arms it.
  const deferSelection = mode === "names" && !query;
  const [selectedIndex, setSelectedIndex] = useState(deferSelection ? -1 : 0);
  useEffect(
    () => setSelectedIndex(deferSelection ? -1 : 0),
    [query, deferSelection],
  );

  // Refs so the once-registered keydown handler reads the latest values.
  const selectedIndexRef = useRef(0);
  selectedIndexRef.current = selectedIndex;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Capture-phase keydown — fires before the engine's handler, so we claim
  // Arrow/Enter/Escape for the menu and let every other key type the query.
  useEffect(() => {
    if (!captureKeyboardNavigation) return;
    const onKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          e.stopPropagation();
          setSelectedIndex((i) => {
            const len = itemsRef.current.length;
            return len === 0 ? 0 : Math.min(i + 1, len - 1);
          });
          break;
        case "ArrowUp":
          e.preventDefault();
          e.stopPropagation();
          setSelectedIndex((i) => {
            const len = itemsRef.current.length;
            // Arming from "no row" goes to the end, so the two arrows differ.
            if (i < 0) return len === 0 ? -1 : len - 1;
            return Math.max(i - 1, 0);
          });
          break;
        case "Enter":
        case "Tab": {
          // No row armed (a bare `/`): let the key reach the editor.
          const item = itemsRef.current[selectedIndexRef.current];
          if (!item) break;
          e.preventDefault();
          e.stopPropagation();
          onSelectRef.current(item.cmd);
          break;
        }
        case "Escape":
          e.preventDefault();
          e.stopPropagation();
          onCloseRef.current();
          break;
        case "ArrowLeft":
        case "ArrowRight":
          onCloseRef.current(); // let the caret move; just dismiss
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [captureKeyboardNavigation]);

  // Auto-close when nothing matches.
  useEffect(() => {
    if (autoCloseOnEmpty && query && items.length === 0) onClose();
  }, [autoCloseOnEmpty, query, items.length, onClose]);

  // Keep the highlighted row in view.
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (items.length === 0) {
    return emptyState ? <div className={className}>{emptyState}</div> : null;
  }

  return (
    <div className={className}>
      <ScrollArea style={{ maxHeight }}>
        <div className="p-1.5">
          {items.map(({ cmd, svg, label }, index) => {
            const isSelected = index === selectedIndex;
            return (
              <button
                key={cmd.id}
                ref={isSelected ? selectedRef : null}
                className={`w-full px-2.5 py-2 flex items-center gap-3 rounded-lg transition-colors ${
                  isSelected ? "bg-accent" : "hover:bg-accent/50"
                }`}
                onClick={() => onSelect(cmd)}
                onMouseDown={(e) => e.preventDefault()}
              >
                <span
                  className="flex h-9 w-[116px] flex-shrink-0 items-center overflow-hidden text-popover-foreground [&>svg]:h-auto [&>svg]:max-h-9 [&>svg]:w-auto [&>svg]:max-w-full"
                  // The preview is engine-rendered SVG (trusted, no user input).
                  dangerouslySetInnerHTML={{ __html: svg }}
                />
                <span
                  className={`flex-1 text-start text-sm truncate ${
                    isSelected
                      ? "text-foreground font-medium"
                      : "text-popover-foreground"
                  }`}
                >
                  {label}
                </span>
              </button>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
};

interface MathCommandDrawerProps {
  query?: string;
  mode?: MathMenuMode;
  onSelect: (cmd: MathCommand) => void;
  onClose: () => void;
}

/**
 * Touch-first math construct picker. Search is intentionally local to the
 * drawer: typing a natural-language query must not write partial LaTeX into the
 * equation. The document changes only after a construct is selected.
 */
export const MathCommandDrawer: React.FC<MathCommandDrawerProps> = ({
  query = "",
  mode = "names",
  onSelect,
  onClose,
}) => {
  const { t } = useTranslation();
  const [search, setSearch] = useState(query);

  useEffect(() => setSearch(query), [query]);

  return (
    <Drawer
      open={true}
      onOpenChange={(open) => !open && onClose()}
      modal={true}
      dismissible={true}
      shouldScaleBackground={false}
    >
      <DrawerContent
        data-editor-overlay
        className="md:h-[min(78vh,640px)] overflow-hidden"
      >
        <div className="mx-auto flex h-full w-full max-w-lg flex-col">
          <DrawerHeader className="pb-2">
            <DrawerTitle>
              {mode === "latex"
                ? t("editor.math.latexCommands", "LaTeX commands")
                : t("editor.math.chooseConstruct", "Choose a math element")}
            </DrawerTitle>
          </DrawerHeader>
          <div className="relative px-4 pb-3">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute start-7 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Escape") onClose();
              }}
              placeholder={t(
                mode === "latex"
                  ? "editor.math.searchLatexCommands"
                  : "editor.math.searchConstructs",
                mode === "latex"
                  ? "Search LaTeX commands…"
                  : "Search fractions, roots, and symbols…",
              )}
              aria-label={t(
                mode === "latex"
                  ? "editor.math.searchLatexCommands"
                  : "editor.math.searchConstructs",
                mode === "latex"
                  ? "Search LaTeX commands…"
                  : "Search fractions, roots, and symbols…",
              )}
              className="h-11 ps-10"
              autoFocus
            />
          </div>
          <MathCommandPalette
            query={search}
            mode={mode}
            onSelect={onSelect}
            onClose={onClose}
            maxHeight={520}
            autoCloseOnEmpty={false}
            captureKeyboardNavigation={false}
            className="min-h-0 flex-1 overflow-hidden border-t border-border/50"
            emptyState={
              <div className="px-4 py-10 text-center text-sm text-muted-foreground">
                {mode === "latex"
                  ? t(
                      "editor.math.noLatexCommands",
                      "No matching LaTeX commands",
                    )
                  : t("editor.math.noConstructs", "No matching math elements")}
              </div>
            }
          />
        </div>
      </DrawerContent>
    </Drawer>
  );
};

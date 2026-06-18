import * as Popover from "@radix-ui/react-popover";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  type Editor,
  filterMathCommands,
  getBlockTextContent,
  getInlineMathSpans,
  isTouchDevice,
  type MathCommand,
  mathCommandCaretOffset,
  renderToSVG,
  TEXT_INPUT,
} from "@cypherkit/editor";
import { ScrollArea } from "../components/ui/scroll-area";

interface MathCommandMenuProps {
  /** The editor this menu observes for `\` input inside a math chip. */
  editor: Editor;
  /** The editor surface's viewport rect, for translating caret coords to screen. */
  getContainerRect: () => DOMRect | null | undefined;
}

/** The `\`-trigger run we're tracking: the block + the index of the `\`. */
interface Trigger {
  blockIndex: number;
  backslashIndex: number;
}

/**
 * Math `\` command menu — a Corca-style autocomplete that pops up when you type
 * `\` *inside* an inline-math chip. Self-contained host chrome (the engine has no
 * notion of it): it observes {@link TEXT_INPUT} to edge-trigger on a `\` typed
 * inside a chip, recomputes the query/anchor from editor state on every change,
 * renders each candidate as live math (via {@link renderToSVG} — empty `{}`
 * slots show as faint placeholder boxes), and on select replaces the typed
 * `\query` with the construct and drops the caret in its first slot. Renders
 * nothing while closed.
 */
export const MathCommandMenu: React.FC<MathCommandMenuProps> = ({
  editor,
  getContainerRect,
}) => {
  // Open trigger lives in a ref (set synchronously inside the TEXT_INPUT handler,
  // before the `\` commits) so the next `subscribe` tick computes the anchor.
  const triggerRef = useRef<Trigger | null>(null);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    query: string;
  } | null>(null);

  const close = React.useCallback(() => {
    triggerRef.current = null;
    setMenu(null);
  }, []);

  const select = React.useCallback(
    (cmd: MathCommand) => {
      const t = triggerRef.current;
      if (!t) return;
      const st = editor.getState();
      const cur = st?.document.cursor;
      const blockId = st?.document.page.blocks[t.blockIndex]?.id;
      if (!st || !cur || !blockId) return;
      const caretIndex = cur.position.textIndex;
      // Replace the typed "\query" with the construct (one undo step). No mark is
      // passed: the run is inserted strictly inside the existing math span, so
      // it's covered positionally — keeping the chip a single, well-anchored span.
      editor.change((c) => {
        c.insertText(cmd.latex, {
          from: { block: blockId, offset: t.backslashIndex },
          to: { block: blockId, offset: caretIndex },
        });
        c.select({
          block: blockId,
          offset: t.backslashIndex + mathCommandCaretOffset(cmd.latex),
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
      const st = editor.getState();
      const cur = st?.document.cursor;
      if (!st || !cur) return close();

      const block = st.document.page.blocks[t.blockIndex];
      if (!block) return close();

      const text = getBlockTextContent(block);
      const caretIndex = cur.position.textIndex;
      // Close when the caret left the `\` run: different block, moved at/before
      // the `\`, or the `\` itself was deleted.
      if (
        cur.position.blockIndex !== t.blockIndex ||
        caretIndex <= t.backslashIndex ||
        text[t.backslashIndex] !== "\\"
      ) {
        return close();
      }
      // In a block equation the whole block is the chip (no span anchors to
      // protect), so any `\…` run triggers. For an inline chip the `\` and caret
      // must both sit STRICTLY inside one span — the `\` past the first char, the
      // caret before the last — so replacing `[backslash, caret)` on select
      // stays interior and never deletes a span anchor char (which would orphan
      // the chip). That's also why you can't start a command at a chip's edge.
      if (block.type !== "math") {
        const chip = getInlineMathSpans(block).find(
          (s) =>
            s.startIndex < t.backslashIndex && t.backslashIndex < s.endIndex,
        );
        if (!chip || caretIndex >= chip.endIndex) return close();
      }

      // A LaTeX command name is letters only — a space/brace/digit ends it.
      const query = text.slice(t.backslashIndex + 1, caretIndex);
      if (!/^[a-zA-Z]*$/.test(query)) return close();

      const coords = editor.coordsAtPos({
        blockIndex: t.blockIndex,
        textIndex: t.backslashIndex,
      });
      const rect = getContainerRect();
      if (!coords || !rect) return;
      const x = rect.left + coords.x;
      const y = rect.top + coords.y + coords.height;
      setMenu((prev) =>
        prev && prev.x === x && prev.y === y && prev.query === query
          ? prev
          : { x, y, query },
      );
    };

    // Edge-trigger the open on a `\` typed *inside* a chip (desktop only — the
    // menu is keyboard-driven). The `\` isn't committed yet, so the anchor/query
    // are computed on the next `subscribe` tick.
    const offInput = editor.registerAction(
      TEXT_INPUT,
      ({ text, blockIndex, textIndex }) => {
        if (text !== "\\" || isTouchDevice()) return;
        const block = editor.getState()?.document.page.blocks[blockIndex];
        if (!block) return;
        // A block equation is itself one big chip (its whole text IS the LaTeX),
        // so a `\` anywhere in it triggers; an inline chip needs the `\` strictly
        // inside the span.
        const inside =
          block.type === "math" ||
          getInlineMathSpans(block).some(
            (s) => s.startIndex < textIndex && textIndex < s.endIndex,
          );
        if (inside)
          triggerRef.current = { blockIndex, backslashIndex: textIndex };
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
    <MathCommandList
      x={menu.x}
      y={menu.y}
      query={menu.query}
      onSelect={select}
      onClose={close}
    />
  );
};

interface MathCommandListProps {
  x: number;
  y: number;
  query: string;
  onSelect: (cmd: MathCommand) => void;
  onClose: () => void;
}

const MathCommandList: React.FC<MathCommandListProps> = ({
  x,
  y,
  query,
  onSelect,
  onClose,
}) => {
  const selectedRef = useRef<HTMLButtonElement>(null);

  const maxHeight = useMemo(() => {
    const viewportHeight =
      typeof window !== "undefined" ? window.innerHeight : 800;
    const available = viewportHeight - y - 20 - 5;
    return Math.max(180, Math.min(420, available));
  }, [y]);

  // Filter + pre-render each candidate's preview SVG (cheap, but memoized so
  // typing a letter doesn't re-render every row's math from scratch).
  const items = useMemo(() => {
    return filterMathCommands(query).map((cmd) => ({
      cmd,
      svg: renderToSVG(cmd.latex, false, 19),
    }));
  }, [query]);

  const [selectedIndex, setSelectedIndex] = useState(0);
  useEffect(() => setSelectedIndex(0), [query]);

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
          setSelectedIndex((i) => Math.max(i - 1, 0));
          break;
        case "Enter":
        case "Tab": {
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
  }, []);

  // Auto-close when nothing matches.
  useEffect(() => {
    if (query && items.length === 0) onClose();
  }, [query, items.length, onClose]);

  // Keep the highlighted row in view.
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (items.length === 0) return null;

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
          className="bg-popover rounded-xl shadow-xl border border-border/50 min-w-[340px] max-w-[420px] z-50 select-none overflow-hidden"
          side="bottom"
          align="start"
          sideOffset={6}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <ScrollArea style={{ maxHeight }}>
            <div className="p-1.5">
              {items.map(({ cmd, svg }, index) => {
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
                      {cmd.name}
                    </span>
                    <span className="flex-shrink-0 text-xs text-muted-foreground/70 font-mono">
                      \{cmd.id}
                    </span>
                  </button>
                );
              })}
            </div>
          </ScrollArea>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
};

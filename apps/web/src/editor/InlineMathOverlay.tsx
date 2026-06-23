import * as Popover from "@radix-ui/react-popover";
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  type Editor,
  EXIT_INLINE_MATH,
  getInlineMathSpans,
  type MathCommand,
  mathCommandCaretOffset,
} from "@cypherkit/editor";
import {
  getInlineMathCaretRect,
  getInlineMathOffsetAtX,
  mathCommandRanges,
  onFontsReady,
} from "@cypherkit/editor/internal";
import { layoutMath, paintMath } from "@cypherkit/tex";
import { MathCommandPalette } from "./MathCommandMenu";

/**
 * WYSIWYG inline-math overlay — a roomy, live mirror of the inline-math chip the
 * caret is currently inside.
 *
 * Inline editing happens *in place* on the canvas (the caret descends into the
 * chip and the engine's edit pipeline handles typing / the `\` command menu /
 * token-aware delete). The on-line chip is tiny, though, so this popover renders
 * the SAME formula large — a second, magnified view of the chip, NOT a raw-LaTeX
 * textarea. It is a pure mirror: it never steals keyboard focus (every keystroke
 * keeps flowing to the main editor and drives the in-place edit), it re-paints
 * from `editor.getState()` on every tick, and a click in it just moves the
 * editor's caret. So it stays perfectly in sync with the small chip.
 *
 * Self-contained host chrome (mirrors {@link import("./MathCommandMenu")}): the
 * engine has no notion of it. It opens whenever the caret sits strictly inside a
 * chip and closes when the caret leaves (click-away / arrow-out / Escape), with
 * no `activeMenu` involvement.
 */
interface InlineMathOverlayProps {
  /** The editor this overlay mirrors. */
  editor: Editor;
  /** The editor surface's viewport rect, for translating caret coords to screen. */
  getContainerRect: () => DOMRect | null | undefined;
}

/** The chip the caret is inside, resolved live from editor state. */
interface OpenChip {
  blockIndex: number;
  blockId: string;
  /** Caret-edge range of the chip within the block's text. */
  startIndex: number;
  endIndex: number;
  /** The chip's LaTeX source (its visible chars). */
  latex: string;
  /** Caret offset within the chip (`cursorTextIndex − startIndex`). */
  offset: number;
  /**
   * Whether a `\command` is actively being *entered* at the caret (the engine's
   * caret-scratch is armed here). Mirrors `MathMark`/`MathNode`'s
   * `commandEntryActive` gate: only then is a `\`-run kept as literal source
   * (`\al`). Merely resting the caret at the trailing edge of a COMPLETE command
   * (`\eta`) must still render the glyph η, not the source.
   */
  commandEntry: boolean;
  /** Screen anchor (chip's start, below the line). */
  screenX: number;
  screenY: number;
}

/** Render size of the magnified formula. */
const FONT_SIZE = 30;
const PAD_X = 18;
const PAD_Y = 14;

function chipsEqual(a: OpenChip | null, b: OpenChip | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.blockId === b.blockId &&
    a.startIndex === b.startIndex &&
    a.endIndex === b.endIndex &&
    a.latex === b.latex &&
    a.offset === b.offset &&
    a.commandEntry === b.commandEntry &&
    a.screenX === b.screenX &&
    a.screenY === b.screenY
  );
}

/**
 * The `\command` run the caret is in the middle of, in chip-local terms — used
 * to dock the `\` palette inside the overlay. Mirrors the floating menu's
 * constraints: the `\` must be strictly inside the chip (past its first char, so
 * replacing `[backslash, caret)` on select never deletes the span's start anchor)
 * and the run between it and the caret must be letters only. Returns null when no
 * command is being typed at the caret.
 */
function activeCommandQuery(
  latex: string,
  offset: number,
): { backslashLocal: number; query: string } | null {
  let i = offset;
  while (i > 0 && /[a-zA-Z]/.test(latex[i - 1])) i--;
  // `\` immediately before the letter run, and not the chip's first char.
  if (i <= 1 || latex[i - 1] !== "\\") return null;
  return { backslashLocal: i - 1, query: latex.slice(i, offset) };
}

export const InlineMathOverlay: React.FC<InlineMathOverlayProps> = ({
  editor,
  getContainerRect,
}) => {
  const [chip, setChip] = useState<OpenChip | null>(null);
  // The `\`-command run that was dismissed (Escape / ←→), keyed by its chip-local
  // backslash position so it re-opens on a fresh `\` but stays closed otherwise.
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);

  // The `\` command being typed in the chip (or null), and whether its palette
  // should show (i.e. not dismissed).
  const activeCmd = chip ? activeCommandQuery(chip.latex, chip.offset) : null;
  const commandOpen = !!activeCmd && activeCmd.backslashLocal !== dismissedAt;

  // Drop a stale dismissal once the caret leaves the `\` run, so the next command
  // opens fresh.
  const activeBackslash = activeCmd ? activeCmd.backslashLocal : null;
  useEffect(() => {
    if (activeBackslash === null && dismissedAt !== null) setDismissedAt(null);
  }, [activeBackslash, dismissedAt]);

  // Resolve the chip the caret is inside (or null) from current editor state.
  // Runs on every `subscribe` tick, so typing / caret moves / scroll all reflect
  // here without any explicit open/close signal.
  useEffect(() => {
    const recompute = () => {
      const st = editor.getState();
      const cur = st?.document.cursor;
      if (!st || !cur) return setChip(null);

      const { blockIndex, textIndex } = cur.position;
      const block = st.document.page.blocks[blockIndex];
      if (!block) return setChip(null);

      // Strictly inside a chip — the boundaries are "just outside", where the
      // caret has left the chip and the overlay should be closed.
      const span = getInlineMathSpans(block).find(
        (s) => textIndex > s.startIndex && textIndex < s.endIndex,
      );
      if (!span) return setChip(null);

      const coords = editor.view.coordsAtPos({
        block: block.id,
        offset: span.startIndex,
      });
      const rect = getContainerRect();
      if (!coords || !rect) return;

      // Command-entry is armed only by typing (a caret move clears the scratch),
      // so this is true exactly while the user is entering a `\command` here —
      // the same gate the on-canvas chip uses to keep a `\`-run literal.
      const scratch = st.ui.caretScratch;
      const commandEntry =
        scratch != null &&
        scratch.blockId === block.id &&
        scratch.offset === textIndex;

      const next: OpenChip = {
        blockIndex,
        blockId: block.id,
        startIndex: span.startIndex,
        endIndex: span.endIndex,
        latex: span.latex,
        offset: textIndex - span.startIndex,
        commandEntry,
        screenX: rect.left + coords.x,
        screenY: rect.top + coords.y + coords.height,
      };
      setChip((prev) => (chipsEqual(prev, next) ? prev : next));
    };

    recompute();
    return editor.subscribe(recompute);
  }, [editor, getContainerRect]);

  // Exit the chip on Escape (caret steps out → overlay closes on the next tick).
  // Suppressed while the `\` palette is open — there, Escape dismisses the
  // palette (handled inside MathCommandPalette) rather than leaving the chip.
  useEffect(() => {
    if (!chip || commandOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      editor.dispatch(EXIT_INLINE_MATH, {
        blockId: chip.blockId,
        startIndex: chip.startIndex,
        endIndex: chip.endIndex,
        direction: "right",
      });
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [editor, chip, commandOpen]);

  if (!chip) return null;

  // Replace the typed `\query` with the chosen construct, dropping the caret in
  // its first slot — the same interior replace the floating menu does, so the
  // chip stays one well-anchored span.
  const onCommandSelect = (command: MathCommand) => {
    if (!activeCmd) return;
    const fromOffset = chip.startIndex + activeCmd.backslashLocal;
    editor.change((c) => {
      c.insertText(command.latex, {
        from: { block: chip.blockId, offset: fromOffset },
        to: { block: chip.blockId, offset: chip.startIndex + chip.offset },
      });
      c.select({
        block: chip.blockId,
        offset: fromOffset + mathCommandCaretOffset(command.latex),
      });
    });
    setDismissedAt(null);
  };

  // Match the on-canvas caret: same theme-resolved cursor color the engine paints.
  const caretColor = editor.view.getStyles().cursor.color;

  return (
    <InlineMathCanvas
      chip={chip}
      caretColor={caretColor}
      onClickOffset={(offset) => {
        editor.change((c) =>
          c.select({ block: chip.blockId, offset: chip.startIndex + offset }),
        );
        // The click lived in the popover (a portal outside the editor), so make
        // sure DOM focus is back on the input surface — otherwise typing/delete
        // would no-op after a mirror click.
        editor.setFocus(true);
      }}
      commandSlot={
        commandOpen && activeCmd ? (
          <MathCommandPalette
            query={activeCmd.query}
            onSelect={onCommandSelect}
            onClose={() => setDismissedAt(activeCmd.backslashLocal)}
            maxHeight={280}
            className="mt-1.5 border-t border-border/40 pt-1.5 min-w-[300px]"
          />
        ) : null
      }
    />
  );
};

const InlineMathCanvas: React.FC<{
  chip: OpenChip;
  caretColor: string;
  onClickOffset: (offset: number) => void;
  commandSlot?: React.ReactNode;
}> = ({ chip, caretColor, onClickOffset, commandSlot }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // The literal/pending `\command` ranges at the caret — the SAME pair the
  // on-canvas chip (`MathMark`) and block equation (`MathNode`) derive, via the
  // shared `mathCommandRanges`, so this mirror stays pixel-consistent with them.
  // `chip.commandEntry` is the command-entry-active gate (a command is being
  // entered here, not merely resting at a complete command's edge).
  const { literalRange, pendingRange } = mathCommandRanges(
    chip.latex,
    chip.offset,
    chip.commandEntry,
  );

  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const layout = layoutMath(chip.latex, {
      fontSize: FONT_SIZE,
      displayMode: false,
      literalRange,
    });

    const cssWidth = Math.ceil(layout.width + PAD_X * 2);
    const cssHeight = Math.ceil(layout.height + layout.depth + PAD_Y * 2);
    const baselineY = PAD_Y + layout.height;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = cssWidth * dpr;
    canvas.height = cssHeight * dpr;
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    // Inherit the popover's resolved text color so the formula matches the theme.
    const color = getComputedStyle(canvas).color || "#000";
    paintMath(ctx, layout, PAD_X, baselineY, { color, pendingRange });

    // Caret (sized to the row it sits on — short in a subscript, tall across a
    // fraction), using the same literal range so its geometry matches the paint.
    const caret = getInlineMathCaretRect(
      chip.latex,
      FONT_SIZE,
      chip.offset,
      literalRange,
    );
    if (caret) {
      ctx.fillStyle = caretColor;
      ctx.fillRect(
        PAD_X + caret.x - 0.75,
        baselineY + caret.top,
        1.5,
        caret.bottom - caret.top,
      );
    }
  }, [chip.latex, chip.offset, literalRange, pendingRange, caretColor]);

  // Repaint after EVERY render (no dep array). The canvas can be (re)mounted or
  // repositioned by Radix — e.g. its measure-then-position on open, or a reflow
  // after undo — without `chip` content changing; a content-keyed effect would
  // skip those and leave the fresh canvas blank. Painting is cheap (tex layout
  // is cached), so unconditional repaint is the reliable choice.
  useLayoutEffect(() => {
    paint();
  });

  // Math glyphs need loaded fonts: the first paint can land before they're ready
  // (correct dimensions, blank glyphs). Repaint once they load — the engine does
  // the same for its main canvas. A ref keeps one subscription across renders.
  const paintRef = useRef(paint);
  paintRef.current = paint;
  useEffect(() => onFontsReady(() => paintRef.current()), []);

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const r = canvas.getBoundingClientRect();
      const layout = layoutMath(chip.latex, {
        fontSize: FONT_SIZE,
        displayMode: false,
        literalRange,
      });
      const baselineY = PAD_Y + layout.height;
      const offset = getInlineMathOffsetAtX(
        chip.latex,
        FONT_SIZE,
        e.clientX - r.left - PAD_X,
        e.clientY - r.top - baselineY,
      );
      onClickOffset(offset);
    },
    [chip.latex, literalRange, onClickOffset],
  );

  return (
    <Popover.Root open={true} modal={false}>
      <Popover.Anchor
        style={{
          position: "fixed",
          left: `${chip.screenX}px`,
          top: `${chip.screenY}px`,
          width: 1,
          height: 1,
        }}
      />
      <Popover.Portal>
        <Popover.Content
          // Tag as editor chrome so the engine's document-mousedown handler
          // (`isInsideEditor` in mount.ts) treats clicks here as in-editor and
          // does NOT blur — otherwise clicking the mirror drops editor focus, the
          // caret stops rendering, and the click never lands in the inline math.
          data-editor-overlay
          className="bg-popover rounded-xl shadow-xl border border-border/50 z-50 select-none p-1.5 text-popover-foreground animate-in fade-in zoom-in-95 duration-100"
          side="bottom"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          // Never take focus: the main editor keeps it and handles every keystroke.
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          // Preventing mousedown's default across the WHOLE surface keeps DOM
          // focus on the editor's hidden input — clicking the padding or Radix's
          // focusable content (tabindex=-1), not just the canvas, would otherwise
          // blur it and stop typing/delete from reaching the editor.
          onMouseDown={(e) => e.preventDefault()}
        >
          <canvas
            ref={canvasRef}
            onClick={handleClick}
            className="block cursor-text"
          />
          {/* `\` command palette, docked beneath the formula (same list the
              floating block-equation menu uses). */}
          {commandSlot}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
};

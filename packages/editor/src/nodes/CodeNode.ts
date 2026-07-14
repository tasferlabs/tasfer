/**
 * CodeNode — an on-canvas, directly-editable multi-line code block.
 *
 * A code block is a single CRDT block whose `charRuns` hold the source text,
 * literal "\n" characters and all. It reuses the entire TextNode geometry stack
 * (caret, selection, hit-test) by overriding just three hooks:
 *
 *   - `wrapLines`        — break on "\n" (a consumed, non-rendered break, exactly
 *                          like a wrap space) so one block spans many lines.
 *   - `resolveFontFamily`— render/measure in monospace.
 *   - `leadingInset` + `contentInsetY`/`contentPaddingBottom` — pad the text
 *                          inside the background box, plus the outer card
 *                          margins that keep prose clear of the box.
 *
 * Editing affordances that the plain text pipeline gets wrong for code are
 * redirected through the action bus in {@link registerActions}: Enter inserts a
 * newline instead of splitting the block. Tab (two spaces) is dispatched from
 * the key handler via {@link INSERT_TAB}. Inline marks never apply — the block's
 * `hasFormats` capability is false (see CODE_CAPS in sync/block-registry).
 */

import {
  type ActionBus,
  type ActionHandler,
  stateAction,
  type StateResult,
} from "../action-bus";
import { insertText } from "../actions/actions";
import {
  registerEmptyBlockBackspaceExit,
  SELECT_ALL,
  SPLIT_BLOCK,
} from "../actions/edit-actions";
import {
  type FontFamily,
  getFontStack,
  type WrappedLine,
  wrapText,
} from "../fonts";
import { cardFlowMargins } from "../node-shared";
import type {
  BlockRuntimeState,
  NodeLayout,
  NodePaintCtx,
  NodeRegionCtx,
} from "../rendering/nodes/Node";
import { moveCursorToPosition, updateSelection } from "../selection";
import { escapeAttr, escapeHtml } from "../serlization/codecs/inline";
import type { NodeCodec } from "../serlization/codecs/types";
import type { Char, CharRun, MarkSpan } from "../serlization/loadPage";
import {
  CODE_BLOCK,
  NEWLINE,
  type VisibleToken,
} from "../serlization/tokenizer";
import type {
  CodeBlockStyle,
  EditorState,
  EditorStyles,
  FontStyles,
  NodeOverlay,
  Operation,
  Position,
  RenderedBlock,
  TextStyle,
} from "../state-types";
import { updateMode } from "../state-utils";
import { CODE_FONT_FAMILY } from "../styles";
import { getVisibleTextFromRuns } from "../sync/char-runs";
import { deleteCharsInRange, insertCharsAtPosition } from "../sync/crdt-utils";
import { cardJoinFlags } from "../sync/reducer";
import { type CodeToken, highlightLine } from "./code-highlight";
import {
  type RenderLineTextArgs,
  TextNode,
  type TextNodeLayout,
  type TextualBlock,
} from "./TextNode";

/** Map a syntax token kind to its themed color. */
function syntaxColor(kind: CodeToken["kind"], cs: CodeBlockStyle): string {
  switch (kind) {
    case "keyword":
      return cs.syntax.keyword;
    case "string":
      return cs.syntax.string;
    case "comment":
      return cs.syntax.comment;
    case "number":
      return cs.syntax.number;
    case "function":
      return cs.syntax.function;
    default:
      return cs.color;
  }
}

/** A code block: editable monospace text (with embedded "\n") plus a language tag. */
export interface CodeBlock extends BlockRuntimeState {
  type: "code";
  charRuns: CharRun[];
  /** Always empty — code carries no inline marks — but kept for the textual shape. */
  formats: MarkSpan[];
  /** Highlighting language hint (e.g. "javascript"); empty when unset. */
  language?: string;
}

/**
 * Insert two spaces at the caret. Dispatched from the Tab key handler when the
 * caret is in a code block (see events/keysEvents). A plain state action so a
 * host can observe/override the indent behavior per instance.
 */
export const INSERT_TAB = stateAction("insert-tab", (state) => {
  const r = insertText(state, "  ");
  return { state: r.state, ops: r.ops };
});

/** One indent level in a code block: two spaces, matching {@link INSERT_TAB}. */
const INDENT_UNIT = "  ";

/**
 * Line-based indent/outdent for a code block — the toolbar's counterpart to
 * Tab / Shift+Tab, where a soft keyboard has no such keys. It reindents every
 * line the caret or selection touches: `indent` prepends two spaces to each
 * line, `outdent` removes up to two leading spaces. The caret and any selection
 * are remapped so they keep covering the same source after the whitespace
 * shifts. A no-op (state returned unchanged, no ops) when the caret is not in a
 * code block, or when `outdent` finds no leading whitespace to remove.
 *
 * This lives on the node — the editor core stays block-type-agnostic — and is
 * exposed as two {@link stateAction}s the host binds to toolbar buttons.
 */
function reindentCodeBlock(
  state: EditorState,
  direction: "indent" | "outdent",
): StateResult {
  const cursor = state.document.cursor;
  if (!cursor) return { state, ops: [] };
  const blockIndex = cursor.position.blockIndex;
  const block = state.document.page.blocks[blockIndex];
  if (!block || block.deleted || block.type !== "code")
    return { state, ops: [] };

  const text = getVisibleTextFromRuns(block.charRuns);

  // The reindented range: the selection when it lies within this block, else the
  // caret. Selection endpoints can be reversed, so normalize to [lo, hi].
  const sel = state.document.selection;
  const inThisBlock =
    sel !== null &&
    !sel.isCollapsed &&
    sel.anchor.blockIndex === blockIndex &&
    sel.focus.blockIndex === blockIndex;
  const lo = inThisBlock
    ? Math.min(sel.anchor.textIndex, sel.focus.textIndex)
    : cursor.position.textIndex;
  const hi = inThisBlock
    ? Math.max(sel.anchor.textIndex, sel.focus.textIndex)
    : cursor.position.textIndex;

  // The line-start offsets the range touches. A selection ending exactly at a
  // line start does not reach into that line, so scan only to `hi - 1` there.
  const lastTouched = hi > lo ? hi - 1 : lo;
  const lineStarts: number[] = [];
  let scan = text.lastIndexOf("\n", lo - 1) + 1;
  while (scan <= lastTouched) {
    lineStarts.push(scan);
    const nl = text.indexOf("\n", scan);
    if (nl === -1) break;
    scan = nl + 1;
  }

  // Per-line edits, derived from the original text. `remove` is how many leading
  // spaces outdent strips (indent never removes); `insert` is fixed for indent.
  const edits = lineStarts
    .map((at) => {
      if (direction === "indent") return { at, insert: INDENT_UNIT.length };
      let n = 0;
      while (n < INDENT_UNIT.length && text[at + n] === " ") n++;
      return { at, insert: 0, remove: n };
    })
    .filter((e) => e.insert > 0 || (e as { remove: number }).remove > 0) as {
    at: number;
    insert: number;
    remove?: number;
  }[];
  if (edits.length === 0) return { state, ops: [] };

  // Apply from the last line up so each edit's offset stays valid against the
  // still-unmutated earlier text.
  const ops: Operation[] = [];
  let page = state.document.page;
  for (let i = edits.length - 1; i >= 0; i--) {
    const e = edits[i];
    if (e.insert > 0) {
      const r = insertCharsAtPosition(
        page,
        block.id,
        e.at,
        INDENT_UNIT,
        state.CRDTbinding,
      );
      page = r.newPage;
      ops.push(r.op);
    } else if (e.remove) {
      const r = deleteCharsInRange(
        page,
        block.id,
        e.at,
        e.at + e.remove,
        state.CRDTbinding,
      );
      page = r.newPage;
      ops.push(r.op);
    }
  }

  // Remap a pre-edit offset across every edit. The edits sit at distinct,
  // non-overlapping line starts, so their shifts are independent and additive: an
  // insert at/left of the offset pushes it right; a delete left of it pulls it
  // left (clamped when the offset falls inside the removed run).
  const remap = (off: number): number => {
    let delta = 0;
    for (const e of edits) {
      if (e.insert > 0) {
        if (e.at <= off) delta += e.insert;
      } else if (e.remove) {
        if (off >= e.at + e.remove) delta -= e.remove;
        else if (off > e.at) delta -= off - e.at;
      }
    }
    return off + delta;
  };

  let next: EditorState = { ...state, document: { ...state.document, page } };
  next = moveCursorToPosition(
    next,
    blockIndex,
    remap(cursor.position.textIndex),
  );
  next = inThisBlock
    ? updateSelection(next, {
        anchor: { blockIndex, textIndex: remap(sel.anchor.textIndex) },
        focus: { blockIndex, textIndex: remap(sel.focus.textIndex) },
      })
    : updateSelection(next, null);
  return { state: next, ops };
}

/** Indent the caret's line(s) in a code block by one level (two spaces). */
export const INDENT_CODE = stateAction("indent-code", (state) =>
  reindentCodeBlock(state, "indent"),
);

/** Outdent the caret's line(s) in a code block by one level (up to two spaces). */
export const OUTDENT_CODE = stateAction("outdent-code", (state) =>
  reindentCodeBlock(state, "outdent"),
);

export class CodeNode extends TextNode {
  readonly type = "code" as const;
  readonly types: readonly string[] = ["code"];
  // All card blocks (code, math, quote) tile together when stacked.
  readonly joinGroup = "card";

  protected estimateLayoutMaxWidth(
    _block: TextualBlock,
    maxWidth: number,
    styles: EditorStyles,
  ): number {
    return maxWidth - styles.blocks.code.paddingX;
  }

  // ── Layout ────────────────────────────────────────────────────────────────

  /**
   * Reserve symmetric horizontal padding. The right inset is taken off `maxWidth`
   * here; the matching left inset is added by {@link leadingInset} (which also
   * shrinks the wrap width), so the text area is `maxWidth - 2·paddingX` wide and
   * starts `paddingX` in from the box's left edge.
   */
  computeLayout(
    block: TextualBlock,
    maxWidth: number,
    styles: EditorStyles,
    content?: {
      chars: Char[];
      formats: MarkSpan[];
      compositionRange: { start: number; end: number } | null;
    },
  ): TextNodeLayout {
    const paddingX = styles.blocks.code.paddingX;
    return super.computeLayout(block, maxWidth - paddingX, styles, content);
  }

  protected resolveFontFamily(_styles: EditorStyles): FontFamily {
    return CODE_FONT_FAMILY;
  }

  protected leadingInset(
    _block: TextualBlock,
    styles: EditorStyles,
  ): { indentOffset: number; markerWidth: number } {
    return { indentOffset: styles.blocks.code.paddingX, markerWidth: 0 };
  }

  /**
   * Top inset = outer card margin (zeroed against an adjacent card) + the
   * box's internal top padding. Mirrored below by `contentPaddingBottom`.
   */
  protected override contentInsetY(
    block: TextualBlock,
    styles: EditorStyles,
    textStyle: TextStyle,
  ): number {
    const margin = cardFlowMargins(block, styles.blocks.code).top;
    return margin + (textStyle.paddingTop ?? 0);
  }

  protected override contentPaddingBottom(
    block: TextualBlock,
    styles: EditorStyles,
    textStyle: TextStyle,
  ): number {
    const margin = cardFlowMargins(block, styles.blocks.code).bottom;
    return textStyle.paddingBottom + margin;
  }

  /**
   * Newline-aware wrap: split the visible text into hard lines at each "\n", then
   * soft-wrap each hard line to the content width. A "\n" is modeled as a
   * consumed (non-rendered) break — `consumedSpace: true` on the line before it —
   * so `computeLayout`'s visible-index accounting advances by one across it,
   * exactly as it does for a wrap space. Code carries no marks, so wrapping each
   * segment with empty `formats` is exact (no math/bold spans to honor).
   */
  protected wrapLines(
    chars: Char[],
    _formats: MarkSpan[],
    maxWidth: number,
    textStyle: TextStyle,
    fontFamily: FontFamily,
    fonts: FontStyles,
    codePadding: number,
    _compositionRange: { start: number; end: number } | null,
  ): WrappedLine[] {
    const visible = chars.filter((c) => !c.deleted);
    const out: WrappedLine[] = [];
    let segStart = 0;

    for (let i = 0; i <= visible.length; i++) {
      const atEnd = i === visible.length;
      if (!atEnd && visible[i].char !== "\n") continue;

      const segChars = visible.slice(segStart, i);
      const wrapped = wrapText(
        segChars,
        [],
        maxWidth,
        textStyle.fontSize,
        textStyle.fontWeight,
        fontFamily,
        fonts,
        codePadding,
        null,
      );
      const newlineFollows = !atEnd; // visible[i] === "\n"
      for (let k = 0; k < wrapped.length; k++) {
        const isLastOfSeg = k === wrapped.length - 1;
        out.push({
          text: wrapped[k].text,
          // The segment's last line consumes the following "\n"; interior lines
          // keep wrapText's own consumed-space flag.
          consumedSpace: isLastOfSeg
            ? newlineFollows
            : wrapped[k].consumedSpace,
        });
      }
      segStart = i + 1;
    }

    if (out.length === 0) out.push({ text: "", consumedSpace: false });
    return out;
  }

  // ── Paint ───────────────────────────────────────────────────────────────────

  paint(passedLayout: NodeLayout, c: NodePaintCtx): RenderedBlock {
    const cs = c.styles.blocks.code;
    const layout = passedLayout as TextNodeLayout;
    const { ctx } = c;
    const x = c.origin.x;
    const y = c.origin.y;

    // Rounded background box behind the text. Spans the full block width; the
    // text inside is inset by paddingX / paddingTop via the layout hooks above.
    // Adjacent code/math blocks (one shared card surface) square off the shared
    // edge so their backgrounds tile into one continuous card, not a rounded seam.
    const { joinTop, joinBottom } = cardJoinFlags(
      c.state.nodes,
      c.state.document.page.blocks,
      c.blockIndex,
    );
    const topRadius = joinTop ? 0 : cs.borderRadius;
    const bottomRadius = joinBottom ? 0 : cs.borderRadius;
    // The box is the padded content surface; the outer flow margins around it
    // (baked into layout.height) stay unpainted breathing room.
    const margins = cardFlowMargins(c.block, cs);
    ctx.save();
    ctx.fillStyle = cs.backgroundColor;
    ctx.beginPath();
    // roundRect radii order: [topLeft, topRight, bottomRight, bottomLeft].
    ctx.roundRect(
      x,
      y + margins.top,
      c.maxWidth,
      layout.height - margins.top - margins.bottom,
      [topRadius, topRadius, bottomRadius, bottomRadius],
    );
    ctx.fill();
    ctx.restore();

    return super.paint(passedLayout, c);
  }

  /**
   * Paint one line as syntax-highlighted tokens. Code carries no CRDT marks, so
   * we bypass the mark-aware renderer and color each token from the theme. For
   * monospace text, token-by-token advance matches the whole-line measurement
   * the caret/selection passes use, so the caret stays aligned.
   */
  protected renderLineText(p: RenderLineTextArgs): void {
    // RTL code is rare; defer to the plain bidi-correct renderer rather than
    // re-implementing right-to-left layout for colored tokens.
    if (p.isRTL) {
      super.renderLineText(p);
      return;
    }

    const cs = p.styles.blocks.code;
    const language = (p.block as CodeBlock).language ?? "";
    const tokens = highlightLine(p.lineText, language);

    const { ctx } = p;
    ctx.direction = "ltr";
    ctx.textBaseline = "alphabetic";
    ctx.font = `${p.textStyle.fontWeight} ${p.textStyle.fontSize}px ${getFontStack(
      p.fontFamily,
      p.styles.fonts,
    )}`;

    let x = p.x;
    for (const tok of tokens) {
      ctx.fillStyle = syntaxColor(tok.kind, cs);
      ctx.fillText(tok.text, x, p.baselineY);
      x += ctx.measureText(tok.text).width;
    }
  }

  // ── Overlays (host chrome) ────────────────────────────────────────────────

  /**
   * Declare the language-picker chrome as a host overlay slot, anchored at the
   * block's top-right corner (the right edge of the background box). The engine
   * stays framework-free — it only locates the slot; the host maps the
   * `"code-language"` key to a React component (see `NODE_OVERLAYS` in
   * MountedEditor) that reads the block's `language` live and writes it back via
   * `setBlock`. Emitted for every visible code block so the tag is always
   * available, not just while editing.
   *
   * Suppressed entirely in a readonly document: the chip is a mutating
   * affordance (selecting a language commits a `language` block_set op), so it
   * must stay hidden like the math hover backdrop and image resize handles. The
   * gate is `isReadonlyBase` (not `mode === "readonly"`) so it also holds in the
   * `select` mode a readonly editor enters for copy.
   */
  overlays(c: NodeRegionCtx): readonly NodeOverlay[] {
    if (c.state.ui.isReadonlyBase) return [];
    return [
      {
        key: "code-language",
        blockId: c.block.id,
        // Point anchor at the box's top-right corner; the host chip positions
        // itself inward from here (it needs no width/height box).
        rect: { x: c.origin.x + c.maxWidth, y: c.origin.y },
      },
    ];
  }

  // ── Editing affordances (action bus) ─────────────────────────────────────────

  registerActions(bus: ActionBus): void {
    // Backspace at the start of an empty code block exits to a paragraph rather
    // than merging into the previous block (shared custom-block behavior).
    registerEmptyBlockBackspaceExit(bus, this.types);

    // First Ctrl/Cmd+A selects this code block's complete source. If that exact
    // range is already selected, pass the next press through to the editor's
    // normal whole-document selection.
    bus.registerState(
      SELECT_ALL,
      (state) => {
        const cursor = state.document.cursor;
        if (!cursor) return;
        const blockIndex = cursor.position.blockIndex;
        const block = state.document.page.blocks[blockIndex];
        if (!block || block.deleted || block.type !== "code") return;

        const length = getVisibleTextFromRuns(block.charRuns).length;
        const selection = state.document.selection;
        const alreadySelected =
          selection !== null &&
          selection.anchor.blockIndex === blockIndex &&
          selection.focus.blockIndex === blockIndex &&
          Math.min(selection.anchor.textIndex, selection.focus.textIndex) ===
            0 &&
          Math.max(selection.anchor.textIndex, selection.focus.textIndex) ===
            length;
        if (alreadySelected) return;

        const start: Position = { blockIndex, textIndex: 0 };
        const end: Position = { blockIndex, textIndex: length };
        let next = moveCursorToPosition(state, blockIndex, length);
        next = {
          ...next,
          document: {
            ...next.document,
            selection: {
              anchor: start,
              focus: end,
              isForward: true,
              isCollapsed: false,
              lastUpdate: Date.now(),
              initialBoundary: { start, end },
            },
          },
        };
        return {
          state: updateMode(next, "select"),
          ops: [],
          handled: true,
        };
      },
      50,
    );

    // Enter in a code block inserts a literal newline instead of splitting the
    // block. Returns `handled: true` only for code blocks; otherwise observes and
    // passes through to the default block-split transform.
    bus.register(
      SPLIT_BLOCK,
      ((state: EditorState) => {
        const cursor = state.document.cursor;
        if (!cursor) return;
        const block = state.document.page.blocks[cursor.position.blockIndex];
        if (!block || block.deleted || block.type !== "code") return;
        const r = insertText(state, "\n");
        return { state: r.state, ops: r.ops, handled: true };
      }) as unknown as ActionHandler<void>,
      0,
    );
  }

  // ── Serialization ────────────────────────────────────────────────────────────
  // Raw text round-trip (no inline-mark processing) — code is verbatim source.

  readonly codec: NodeCodec = {
    markdown: {
      tokens: [CODE_BLOCK],
      input: (ctx) => {
        ctx.match(CODE_BLOCK);
        const raw = (ctx.previous() as VisibleToken).content;
        let code = "";
        let language = "";
        try {
          const parsed = JSON.parse(raw) as {
            code?: string;
            language?: string;
          };
          code = parsed.code ?? "";
          language = parsed.language ?? "";
        } catch {
          // Malformed token payload — fall back to an empty code block.
        }
        ctx.match(NEWLINE);

        const block: CodeBlock = {
          id: ctx.nextBlockId(),
          type: "code",
          charRuns: ctx.rawText(code),
          formats: [],
          language,
        };
        return block;
      },
      output: (block) => {
        const b = block as CodeBlock;
        const text = getVisibleTextFromRuns(b.charRuns);
        return "```" + (b.language ?? "") + "\n" + text + "\n```";
      },
    },
    html: {
      output: (block) => {
        const b = block as CodeBlock;
        const text = getVisibleTextFromRuns(b.charRuns);
        const cls = b.language
          ? ` class="language-${escapeAttr(b.language)}"`
          : "";
        return `<pre><code${cls}>${escapeHtml(text)}</code></pre>`;
      },
    },
    text: {
      output: (block) => getVisibleTextFromRuns((block as CodeBlock).charRuns),
    },
  };
}

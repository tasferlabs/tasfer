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
 *   - `leadingInset` + `contentInsetY` — pad the text inside a background box.
 *
 * Editing affordances that the plain text pipeline gets wrong for code are
 * redirected through the action bus in {@link registerActions}: Enter inserts a
 * newline instead of splitting the block. Tab (two spaces) is dispatched from
 * the key handler via {@link INSERT_TAB}. Inline marks never apply — the block's
 * `hasFormats` capability is false (see CODE_CAPS in sync/block-registry).
 */

import { type ActionBus, type ActionHandler, stateAction } from "../action-bus";
import { insertText } from "../actions/actions";
import { SPLIT_BLOCK } from "../actions/edit-actions";
import {
  type FontFamily,
  getFontStack,
  type WrappedLine,
  wrapText,
} from "../fonts";
import type {
  BlockRuntimeState,
  NodeLayout,
  NodePaintCtx,
  NodeRegionCtx,
} from "../rendering/nodes/Node";
import { escapeAttr, escapeHtml } from "../serlization/codecs/inline";
import type { InputCtx } from "../serlization/codecs/types";
import type { Block, Char, CharRun, MarkSpan } from "../serlization/loadPage";
import {
  CODE_BLOCK,
  NEWLINE,
  type TokenType,
  type VisibleToken,
} from "../serlization/tokenizer";
import type {
  CodeBlockStyle,
  EditorState,
  EditorStyles,
  FontStyles,
  NodeOverlay,
  RenderedBlock,
  TextStyle,
} from "../state-types";
import { CODE_FONT_FAMILY } from "../styles";
import { getVisibleTextFromRuns } from "../sync/char-runs";
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

export class CodeNode extends TextNode {
  readonly type = "code" as const;
  readonly types: readonly string[] = ["code"];

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

  protected contentInsetY(_block: TextualBlock, styles: EditorStyles): number {
    return styles.blocks.code.paddingTop;
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
    ctx.save();
    ctx.fillStyle = cs.backgroundColor;
    ctx.beginPath();
    ctx.roundRect(x, y, c.maxWidth, layout.height, cs.borderRadius);
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
   * `setNodeAttrs`. Emitted for every visible code block so the tag is always
   * available, not just while editing.
   */
  overlays(c: NodeRegionCtx): readonly NodeOverlay[] {
    return [
      {
        key: "code-language",
        blockIndex: c.blockIndex,
        // Point anchor at the box's top-right corner; the host chip positions
        // itself inward from here (it needs no width/height box).
        rect: { x: c.origin.x + c.maxWidth, y: c.origin.y },
      },
    ];
  }

  // ── Editing affordances (action bus) ─────────────────────────────────────────

  registerActions(bus: ActionBus): void {
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

  readonly markdownTokens: readonly TokenType[] = [CODE_BLOCK];

  inputMarkdown(ctx: InputCtx): Block {
    ctx.match(CODE_BLOCK);
    const raw = (ctx.previous() as VisibleToken).content;
    let code = "";
    let language = "";
    try {
      const parsed = JSON.parse(raw) as { code?: string; language?: string };
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
  }

  outputMarkdown(block: TextualBlock): string {
    const b = block as CodeBlock;
    const text = getVisibleTextFromRuns(b.charRuns);
    return "```" + (b.language ?? "") + "\n" + text + "\n```";
  }

  outputHTML(block: TextualBlock): string {
    const b = block as CodeBlock;
    const text = getVisibleTextFromRuns(b.charRuns);
    const cls = b.language ? ` class="language-${escapeAttr(b.language)}"` : "";
    return `<pre><code${cls}>${escapeHtml(text)}</code></pre>`;
  }

  outputText(block: TextualBlock): string {
    return getVisibleTextFromRuns((block as CodeBlock).charRuns);
  }
}

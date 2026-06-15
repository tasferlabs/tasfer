/**
 * ListNode — the on-canvas behavior for the bullet/numbered/todo list
 * family. It is a thin extension of {@link TextNode}: lists ARE text blocks
 * (same wrap, caret, selection, hit-test geometry), they just reserve a leading
 * gutter for an indent + marker and draw a marker on the first line.
 *
 * Everything list-specific lives here, behind the three `protected` hooks
 * TextNode exposes (`leadingInset`, `paintMarker`, `placeholderText`). That
 * keeps lists fully opt-in: a host that doesn't register a `ListNode` gets an
 * editor with no list blocks, and TextNode never references list types.
 *
 * Serialization for the list family lives here too, as methods on the class:
 * the markdown/HTML/text round-trip (`- ` / `1. ` / `- [ ]`, `<li>`), adapted
 * into a BlockCodec by the schema. Cross-item concerns stay with the
 * orchestrators: the markdown serializer computes `ctx.listNumber` for numbered
 * items (numbering depends on neighbors), and the HTML serializer owns
 * <ul>/<ol> group wrapping — this codec's html output is the `<li>` element
 * only.
 */

import { stateAction } from "../action-bus";
import {
  indentListItem,
  outdentListItem,
  toggleTodoChecked,
} from "../actions/actions";
import { currentFontFamily, getFontMetrics, getFontStack } from "../fonts";
import { getBlockTextContent } from "../node-shared";
import type {
  BlockRuntimeState,
  NodeHitRegion,
  NodeRegionCtx,
} from "../rendering/nodes/Node";
import { getTextDirection } from "../rtl";
import type { InputCtx, OutputCtx } from "../serlization/codecs/types";
import {
  type Block,
  type CharRun,
  type MarkSpan,
} from "../serlization/loadPage";
import {
  BULLET_LIST,
  NUMBERED_LIST,
  TODO_LIST_CHECKED,
  TODO_LIST_UNCHECKED,
  type TokenType,
} from "../serlization/tokenizer";
import type { EditorState, EditorStyles } from "../state-types";
import { getTextStyle } from "../styles";
import { isListType } from "../sync/block-registry";
import { TextNode, type TextNodeLayout, type TextualBlock } from "./TextNode";

/** The block types handled by ListNode. */
export const LIST_BLOCK_TYPES = [
  "bullet_list",
  "numbered_list",
  "todo_list",
] as const;

// ─── List actions ────────────────────────────────────────────────────────────
//
// The list-specific edit actions live with the node that owns the list family.
// Each wraps the matching pure transform in `actions/actions.ts` so hosts can
// observe/override it, and dispatches via `state.actionBus.dispatchState(...)`
// from the event handlers (Tab/Shift+Tab in `keysEvents.ts`, the todo-checkbox
// region in `blockRegions.ts`).

/** Indent the current list item one level (Tab on a list block). */
export const INDENT_LIST_ITEM = stateAction("indent-list-item", (state) => {
  const result = indentListItem(state);
  return { state: result.state, ops: result.ops };
});

/** Outdent the current list item one level (Shift+Tab on a list block). */
export const OUTDENT_LIST_ITEM = stateAction("outdent-list-item", (state) => {
  const result = outdentListItem(state);
  return { state: result.state, ops: result.ops };
});

/**
 * Toggle a todo list item's checked state (tapping its checkbox). The handler
 * resolves the tapped block's index from the `todo-checkbox` hit region and
 * passes it in; emits the resulting `block_set` op.
 */
export const TOGGLE_TODO_CHECKED = stateAction<{ blockIndex: number }>(
  "toggle-todo-checked",
  (state, { blockIndex }) => {
    const result = toggleTodoChecked(state, blockIndex);
    return { state: result.state, ops: result.ops };
  },
);

// List item blocks - support bullet, numbered, and todo lists with nesting
export interface BulletListItem extends BlockRuntimeState {
  type: "bullet_list";
  charRuns: CharRun[]; // Character runs (squashed CRDT storage)
  formats: MarkSpan[]; // Format spans reference char IDs
  indent: number; // 0-based indent level (0 = no indent)
}

export interface NumberedListItem extends BlockRuntimeState {
  type: "numbered_list";
  charRuns: CharRun[]; // Character runs (squashed CRDT storage)
  formats: MarkSpan[]; // Format spans reference char IDs
  indent: number; // 0-based indent level (0 = no indent)
}

export interface TodoListItem extends BlockRuntimeState {
  type: "todo_list";
  charRuns: CharRun[]; // Character runs (squashed CRDT storage)
  formats: MarkSpan[]; // Format spans reference char IDs
  checked: boolean;
  indent: number; // 0-based indent level (0 = no indent)
}
// List blocks contain list items with text content
export type ListBlock = BulletListItem | NumberedListItem | TodoListItem;

/**
 * Narrow a block to the list family. Mirrors the `isListBlock` guard in
 * `loadPage`, but routes the runtime check through the canvas-free
 * `isListType` (from the block registry) so the rendering layer never
 * runtime-imports `loadPage` — keeping that module out of the sync/fuzz graph.
 */
function isListBlock(block: Block): block is ListBlock {
  return isListType(block.type);
}

/**
 * Item number for a numbered list item — counts preceding same-indent siblings.
 * Moved verbatim from TextNode so behavior is preserved.
 */
function calculateListItemNumber(
  state: EditorState,
  blockIndex: number,
): number {
  const currentBlock = state.document.page.blocks[blockIndex];
  if (!currentBlock || currentBlock.deleted) return 0;
  if (!isListBlock(currentBlock) || currentBlock.type !== "numbered_list") {
    return 1;
  }

  const currentIndent = currentBlock.indent;
  let number = 1;

  const visibleBlocks = state.view.visibleBlocks;
  const allBlocks = state.document.page.blocks;

  for (let i = visibleBlocks.length - 1; i >= 0; i--) {
    const visibleBlock = visibleBlocks[i];
    const visibleBlockIndex = allBlocks.findIndex(
      (b) => b.id === visibleBlock.id,
    );

    if (visibleBlockIndex >= blockIndex) continue;

    const prevBlock = visibleBlock;

    if (!isListBlock(prevBlock) || prevBlock.type !== "numbered_list") {
      break;
    }

    if ((prevBlock.indent ?? 0) > (currentIndent ?? 0)) {
      continue;
    }

    if ((prevBlock.indent ?? 0) < (currentIndent ?? 0)) {
      break;
    }

    number++;
  }

  return number;
}

export class ListNode extends TextNode {
  // Representative type; registered under every LIST_BLOCK_TYPES key.
  readonly type: TextualBlock["type"] = "bullet_list";
  readonly types: readonly string[] = LIST_BLOCK_TYPES;

  /** Lists reserve `indent * indentSize` plus a fixed marker gutter. */
  protected leadingInset(
    block: TextualBlock,
    styles: EditorStyles,
  ): { indentOffset: number; markerWidth: number } {
    if (!isListBlock(block)) return { indentOffset: 0, markerWidth: 0 };
    const indent = block.indent || 0;
    return {
      indentOffset: indent * styles.list.indent.size,
      markerWidth: styles.list.numbered.minWidth + styles.list.marker.textGap,
    };
  }

  /** Draw the bullet, number, or checkbox on the block's first line. */
  protected paintMarker(
    ctx: CanvasRenderingContext2D,
    block: TextualBlock,
    markerX: number,
    lineTopY: number,
    layout: TextNodeLayout,
    styles: EditorStyles,
    state: EditorState,
    blockIndex: number,
  ): void {
    if (!isListBlock(block)) return;

    const { fontMetrics, textStyle } = layout;
    const fontFamily = currentFontFamily(styles);

    if (block.type === "bullet_list") {
      ctx.save();
      ctx.fillStyle = styles.list.bullet.color;
      ctx.font = `${textStyle.fontWeight} ${styles.list.bullet.size}px ${getFontStack(fontFamily, styles.fonts)}`;
      ctx.textBaseline = "alphabetic";

      const bulletX = markerX + 6;

      ctx.fillText(
        styles.list.bullet.character,
        bulletX,
        lineTopY + fontMetrics.ascent,
      );
      ctx.restore();
    } else if (block.type === "numbered_list") {
      const number = calculateListItemNumber(state, blockIndex);
      const numberText = `${number}.`;

      ctx.save();
      ctx.fillStyle = styles.list.numbered.color;
      ctx.font = `${textStyle.fontWeight} ${textStyle.fontSize}px ${getFontStack(fontFamily, styles.fonts)}`;
      ctx.textBaseline = "alphabetic";
      ctx.textAlign = "right";

      ctx.fillText(numberText, markerX + 18, lineTopY + fontMetrics.ascent);

      ctx.textAlign = "left"; // Reset
      ctx.restore();
    } else if (block.type === "todo_list") {
      const checkboxSize = styles.list.todo.checkboxSize;
      const checkboxY = lineTopY + fontMetrics.ascent - checkboxSize + 2;

      const checkboxX = markerX + 2;

      ctx.save();

      ctx.strokeStyle = styles.list.todo.checkboxBorderColor;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.roundRect(
        checkboxX,
        checkboxY,
        checkboxSize,
        checkboxSize,
        styles.list.todo.checkboxBorderRadius,
      );
      ctx.stroke();

      if (block.checked) {
        ctx.fillStyle = styles.list.todo.checkboxCheckedColor;
        ctx.fill();

        ctx.strokeStyle = styles.list.todo.checkmarkColor;
        ctx.lineWidth = 2;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";

        const checkmarkPadding = 3;
        const checkX = checkboxX + checkmarkPadding;
        const checkY = checkboxY + checkmarkPadding;
        const checkWidth = checkboxSize - checkmarkPadding * 2;
        const checkHeight = checkboxSize - checkmarkPadding * 2;

        ctx.beginPath();
        ctx.moveTo(checkX, checkY + checkHeight / 2);
        ctx.lineTo(checkX + checkWidth / 3, checkY + checkHeight - 1);
        ctx.lineTo(checkX + checkWidth, checkY + 1);
        ctx.stroke();
      }

      ctx.restore();
    }
  }

  /**
   * The todo checkbox is an interactive sub-region. Geometry mirrors
   * paintMarker (marker gutter + 2, ascent-aligned, RTL-aware) with a small
   * padding for easier clicking; the toggle behavior is bound to the
   * "todo-checkbox" id in the event layer.
   */
  regions(c: NodeRegionCtx): readonly NodeHitRegion[] {
    const block = c.block;
    if (block.type !== "todo_list" || !isListBlock(block)) return [];
    return [
      {
        id: "todo-checkbox",
        hitTest: (p) => {
          const styles = c.styles;
          const { indentOffset, markerWidth } = this.leadingInset(
            block,
            styles,
          );
          const checkboxSize = styles.list.todo.checkboxSize;

          // RTL puts the marker gutter on the right side
          const isRTL = getTextDirection(getBlockTextContent(block)) === "rtl";
          const adjustedMaxWidth = c.maxWidth - indentOffset - markerWidth;
          const checkboxX = isRTL
            ? c.origin.x + indentOffset + adjustedMaxWidth + 2
            : c.origin.x + indentOffset + 2;

          const textStyle = getTextStyle(styles, block.type);
          const fontMetrics = getFontMetrics(
            textStyle.fontSize,
            textStyle.fontWeight,
            currentFontFamily(styles),
            styles.fonts,
          );
          const checkboxY = c.origin.y + fontMetrics.ascent - checkboxSize + 2;

          const pad = 4; // click/tap tolerance beyond the drawn box
          const inside =
            p.x >= checkboxX - pad &&
            p.x <= checkboxX + checkboxSize + pad &&
            p.y >= checkboxY - pad &&
            p.y <= checkboxY + checkboxSize + pad;
          return inside ? { blockIndex: c.blockIndex } : null;
        },
      },
    ];
  }

  /** List/todo placeholder text; falls back to the base for anything else. */
  protected placeholderText(
    block: TextualBlock,
    styles: EditorStyles,
    state: EditorState,
  ): string {
    if (block.type === "todo_list") {
      return styles.placeholder.todoItem.text;
    }
    if (block.type === "bullet_list" || block.type === "numbered_list") {
      return styles.placeholder.listItem.text;
    }
    return super.placeholderText(block, styles, state);
  }

  // ── Serialization ──────────────────────────────────────────────────────────

  readonly markdownTokens: readonly TokenType[] = [
    BULLET_LIST,
    NUMBERED_LIST,
    TODO_LIST_UNCHECKED,
    TODO_LIST_CHECKED,
  ];

  outputMarkdown(block: ListBlock, ctx: OutputCtx): string {
    const b = block;
    const indent = " ".repeat(b.indent * 2);
    const content = ctx.inline(b.charRuns, b.formats);

    if (b.type === "bullet_list") {
      return `${indent}- ${content}`;
    }
    if (b.type === "numbered_list") {
      return `${indent}${ctx.listNumber ?? 1}. ${content}`;
    }
    // todo_list
    const checkbox = (b as TodoListItem).checked ? "[x]" : "[ ]";
    return `${indent}- ${checkbox} ${content}`;
  }

  inputMarkdown(ctx: InputCtx): Block {
    if (ctx.match(BULLET_LIST)) {
      const { charRuns, formats } = ctx.inlineText();
      const item: BulletListItem = {
        id: ctx.nextBlockId(),
        type: "bullet_list",
        charRuns,
        formats,
        indent: ctx.indent,
      };
      return item;
    }

    if (ctx.match(NUMBERED_LIST)) {
      const { charRuns, formats } = ctx.inlineText();
      const item: NumberedListItem = {
        id: ctx.nextBlockId(),
        type: "numbered_list",
        charRuns,
        formats,
        indent: ctx.indent,
      };
      return item;
    }

    const checked = ctx.check(TODO_LIST_CHECKED);
    ctx.match(TODO_LIST_CHECKED, TODO_LIST_UNCHECKED);
    const { charRuns, formats } = ctx.inlineText();
    const item: TodoListItem = {
      id: ctx.nextBlockId(),
      type: "todo_list",
      charRuns,
      formats,
      checked,
      indent: ctx.indent,
    };
    return item;
  }

  /** The <li> element only — group wrapping (<ul>/<ol>) is the orchestrator's. */
  outputHTML(block: ListBlock, ctx: OutputCtx): string {
    const b = block;
    const inner = ctx.inline(b.charRuns, b.formats);
    if (b.type === "todo_list") {
      const checked = (b as TodoListItem).checked ? " checked" : "";
      return `<li><input type="checkbox" disabled${checked} /><span>${inner}</span></li>`;
    }
    return `<li>${inner}</li>`;
  }

  outputText(block: ListBlock, ctx: OutputCtx): string {
    const b = block;
    const text = ctx.inline(b.charRuns, b.formats);
    if (b.type === "todo_list") {
      const checkbox = (b as TodoListItem).checked ? "[x]" : "[ ]";
      return `${checkbox} ${text}`;
    }
    return text;
  }
}

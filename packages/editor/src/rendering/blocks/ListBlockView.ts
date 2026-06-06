/**
 * ListBlockView — the on-canvas behavior for the bullet/numbered/todo list
 * family. It is a thin extension of {@link TextBlockView}: lists ARE text blocks
 * (same wrap, caret, selection, hit-test geometry), they just reserve a leading
 * gutter for an indent + marker and draw a marker on the first line.
 *
 * Everything list-specific lives here, behind the three `protected` hooks
 * TextBlockView exposes (`leadingInset`, `paintMarker`, `placeholderText`). That
 * keeps lists fully opt-in: a host that doesn't register `listBlockView` gets an
 * editor with no list blocks, and TextBlockView never references list types.
 */

import { getCurrentFontFamily, getFontStack } from "../../fonts";
import { isListBlock, type TextualBlock } from "../../serlization/loadPage";
import type { EditorState, EditorStyles } from "../../state-types";
import { type TextBlockLayout, TextBlockView } from "./TextBlockView";
import i18next from "i18next";

/** The block types handled by ListBlockView. */
export const LIST_BLOCK_TYPES = [
  "bullet_list",
  "numbered_list",
  "todo_list",
] as const;

/**
 * Item number for a numbered list item — counts preceding same-indent siblings.
 * Moved verbatim from TextBlockView so behavior is preserved.
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

export class ListBlockView extends TextBlockView {
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
    layout: TextBlockLayout,
    styles: EditorStyles,
    state: EditorState,
    blockIndex: number,
  ): void {
    if (!isListBlock(block)) return;

    const { fontMetrics, textStyle } = layout;
    const fontFamily = getCurrentFontFamily();

    if (block.type === "bullet_list") {
      ctx.save();
      ctx.fillStyle = styles.list.bullet.color;
      ctx.font = `${textStyle.fontWeight} ${styles.list.bullet.size}px ${getFontStack(fontFamily)}`;
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
      ctx.font = `${textStyle.fontWeight} ${textStyle.fontSize}px ${getFontStack(fontFamily)}`;
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

  /** List/todo placeholder text; falls back to the base for anything else. */
  protected placeholderText(
    block: TextualBlock,
    styles: EditorStyles,
    state: EditorState,
  ): string {
    if (block.type === "todo_list") {
      return i18next.t("blocks.todoItem", "To-do item");
    }
    if (block.type === "bullet_list" || block.type === "numbered_list") {
      return i18next.t("blocks.listItem", "List item");
    }
    return super.placeholderText(block, styles, state);
  }
}

/** Singleton list view, shared across editors (holds no per-editor state). */
export const listBlockView = new ListBlockView();

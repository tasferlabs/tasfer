/**
 * Canvas paint backend: walk a laid-out box tree and draw it with `fillText`
 * (glyphs) and `fillRect` (rules). This is the only canvas-aware layer — and
 * the whole reason the engine exists. No SVG, no rasterization, no bitmap
 * cache: color is just `fillStyle`, and high-DPI is whatever transform the
 * caller already set on the context.
 */
import type { Box } from "../layout/box.ts";
import { fontFamily } from "../fonts/fonts.ts";
import type { MathLayout } from "../index.ts";

export interface PaintOptions {
  /** Base text color (CSS string). Per-glyph colors override it. */
  color?: string;
  /**
   * Source range of a command the user is *still typing* (`\al` on the way to
   * `\alpha`). Glyphs whose span falls within it skip their red "unknown
   * command" placeholder color and paint in the base `color` instead — the
   * command isn't an error yet, just in progress. Resolve it with
   * `pendingCommandRange`; once the caret moves off the run it no longer matches
   * and the red shows. Omit for static rendering (export, the menu previews).
   */
  pendingRange?: { start: number; end: number };
}

/**
 * Paint `layout` with its baseline origin at `(x, y)` — `x` is the left edge,
 * `y` is the baseline. The caller is responsible for any DPI scaling on `ctx`.
 */
export function paintMath(
  ctx: CanvasRenderingContext2D,
  layout: MathLayout,
  x: number,
  y: number,
  opts: PaintOptions = {},
): void {
  const prevBaseline = ctx.textBaseline;
  const prevAlign = ctx.textAlign;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  paintBox(ctx, layout.box, x, y, layout.fontSize, opts.color ?? "#000", opts.pendingRange);
  ctx.textBaseline = prevBaseline;
  ctx.textAlign = prevAlign;
}

function paintBox(
  ctx: CanvasRenderingContext2D,
  box: Box,
  x: number,
  y: number,
  fontSize: number,
  color: string,
  pendingRange?: { start: number; end: number },
): void {
  switch (box.type) {
    case "glyph": {
      if (box.char === "" || (box.width === 0 && box.height === 0)) return;
      ctx.font = `${box.size * fontSize}px "${fontFamily(box.variant)}"`;
      // A per-glyph color override marks an unknown-command placeholder (red).
      // Suppress it while this glyph belongs to a command still being typed
      // (its span falls within the pending-command range) — not an error yet.
      const stillTyping =
        box.color != null &&
        pendingRange != null &&
        box.span != null &&
        box.span.start >= pendingRange.start &&
        box.span.end <= pendingRange.end;
      ctx.fillStyle = stillTyping ? color : box.color ?? color;
      if (box.yScale != null && box.yScale !== 1) {
        // Scale vertically about the baseline to stretch extensible pieces.
        ctx.save();
        ctx.translate(x, y);
        ctx.scale(1, box.yScale);
        ctx.fillText(box.char, 0, 0);
        ctx.restore();
      } else {
        ctx.fillText(box.char, x, y);
      }
      break;
    }
    case "rule": {
      ctx.fillStyle = color;
      ctx.fillRect(
        x,
        y - box.height * fontSize,
        box.width * fontSize,
        (box.height + box.depth) * fontSize,
      );
      break;
    }
    case "path": {
      ctx.beginPath();
      for (const [op, px, py] of box.commands) {
        const cx = x + px * fontSize;
        const cy = y + py * fontSize;
        if (op === "M") ctx.moveTo(cx, cy);
        else ctx.lineTo(cx, cy);
      }
      if (box.strokeWidth != null) {
        ctx.strokeStyle = color;
        ctx.lineWidth = box.strokeWidth * fontSize;
        ctx.lineJoin = "miter";
        ctx.lineCap = "butt";
        ctx.stroke();
      } else {
        ctx.fillStyle = color;
        ctx.fill();
      }
      break;
    }
    case "placeholder": {
      // A faint translucent block marking an empty, editable slot.
      ctx.save();
      ctx.globalAlpha *= 0.12;
      ctx.fillStyle = color;
      ctx.fillRect(
        x,
        y - box.height * fontSize,
        box.width * fontSize,
        (box.height + box.depth) * fontSize,
      );
      ctx.restore();
      break;
    }
    case "list": {
      for (const child of box.children) {
        paintBox(
          ctx,
          child.box,
          x + child.dx * fontSize,
          y + child.dy * fontSize,
          fontSize,
          color,
          pendingRange,
        );
      }
      break;
    }
  }
}

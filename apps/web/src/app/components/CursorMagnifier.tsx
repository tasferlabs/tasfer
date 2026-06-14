import { useEffect, useRef } from "react";
import {
  MAGNIFIER_HEIGHT,
  MAGNIFIER_MIN_OFFSET_Y,
  MAGNIFIER_POINTER_SIZE,
  MAGNIFIER_WIDTH,
} from "@cypherkit/editor";
import type { CursorDragState } from "@cypherkit/editor";

interface CursorMagnifierProps {
  cursorDrag: CursorDragState | null;
  contentCanvas: HTMLCanvasElement | null;
  cursorCanvas: HTMLCanvasElement | null;
  containerRect: DOMRect | null;
}

function getBackgroundColor(): string {
  return getComputedStyle(document.documentElement)
    .getPropertyValue("--background")
    .trim();
}

function getBorderColor(): string {
  const isDark = document.documentElement.classList.contains("dark");
  return isDark ? "rgba(255, 255, 255, 0.2)" : "rgba(0, 0, 0, 0.15)";
}

/**
 * Compute adaptive zoom so that the current line fits comfortably in the
 * magnifier regardless of font size. Small text (paragraph) gets more
 * magnification; large text (heading1) gets less.
 */
function computeZoom(lineHeight: number): number {
  const maxZoomForLine = MAGNIFIER_HEIGHT / (lineHeight * 1.4);
  return Math.max(1.0, Math.min(1.5, maxZoomForLine));
}

/**
 * Compute Y offset above the touch point based on the finger's contact radius.
 * When the browser reports a touch radius, use it to clear the finger;
 * otherwise fall back to a reasonable minimum.
 */
function computeOffsetY(touchRadiusY: number): number {
  if (touchRadiusY > 0) {
    // Place the magnifier above the full finger contact area + a small gap
    return touchRadiusY * 2 + 12;
  }
  return MAGNIFIER_MIN_OFFSET_Y;
}

const TOTAL_HEIGHT = MAGNIFIER_HEIGHT + MAGNIFIER_POINTER_SIZE;

export function CursorMagnifier({
  cursorDrag,
  contentCanvas,
  cursorCanvas,
  containerRect,
}: CursorMagnifierProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);
  const cursorDragRef = useRef(cursorDrag);
  cursorDragRef.current = cursorDrag;

  const isActive = cursorDrag?.isActive ?? false;

  useEffect(() => {
    if (!isActive || !contentCanvas) {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
      return;
    }

    const magnifierCanvas = canvasRef.current;
    if (!magnifierCanvas) return;

    const dpr = window.devicePixelRatio || 1;
    magnifierCanvas.width = MAGNIFIER_WIDTH * dpr;
    magnifierCanvas.height = MAGNIFIER_HEIGHT * dpr;

    const ctx = magnifierCanvas.getContext("2d");
    if (!ctx) return;

    const draw = () => {
      const drag = cursorDragRef.current;
      if (!drag?.isActive) return;

      const zoom = computeZoom(drag.lineHeight);

      ctx.clearRect(0, 0, magnifierCanvas.width, magnifierCanvas.height);
      ctx.save();
      ctx.scale(dpr, dpr);

      // Fill with page background so transparent canvas areas have contrast
      ctx.fillStyle = getBackgroundColor();
      ctx.fillRect(0, 0, MAGNIFIER_WIDTH, MAGNIFIER_HEIGHT);

      // Source region: centered on cursor position in the content canvas
      const sourceWidth = MAGNIFIER_WIDTH / zoom;
      const sourceHeight = MAGNIFIER_HEIGHT / zoom;
      const sw = sourceWidth * dpr;
      const sh = sourceHeight * dpr;

      // Clamp source center so the view region never extends past
      // the canvas bounds (iOS-style: stops panning at edges)
      const cw = contentCanvas.width;
      const ch = contentCanvas.height;
      const cx = Math.max(sw / 2, Math.min(cw - sw / 2, drag.cursorX * dpr));
      // cursorY is the top of the line; center on the cursor's vertical midpoint
      const cursorMidY = (drag.cursorY + drag.lineHeight / 2) * dpr;
      const cy = Math.max(sh / 2, Math.min(ch - sh / 2, cursorMidY));
      const sx = cx - sw / 2;
      const sy = cy - sh / 2;

      // Composite content layer
      ctx.drawImage(
        contentCanvas,
        sx, sy, sw, sh,
        0, 0, MAGNIFIER_WIDTH, MAGNIFIER_HEIGHT,
      );

      // Composite cursor layer on top
      if (cursorCanvas) {
        ctx.drawImage(
          cursorCanvas,
          sx, sy, sw, sh,
          0, 0, MAGNIFIER_WIDTH, MAGNIFIER_HEIGHT,
        );
      }

      ctx.restore();

      rafRef.current = requestAnimationFrame(draw);
    };

    rafRef.current = requestAnimationFrame(draw);

    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
    };
  }, [isActive, contentCanvas, cursorCanvas]);

  if (!cursorDrag?.isActive || !containerRect) return null;

  const offsetY = computeOffsetY(cursorDrag.touchRadiusY);

  // Position magnifier centered on touch X, above the finger
  let left = containerRect.left + cursorDrag.touchX - MAGNIFIER_WIDTH / 2;
  let top =
    containerRect.top + cursorDrag.touchY - offsetY - TOTAL_HEIGHT;

  // If too close to top, flip below finger
  if (top < 0) {
    top = containerRect.top + cursorDrag.touchY + offsetY;
  }

  // Clamp horizontally to viewport
  left = Math.max(4, Math.min(window.innerWidth - MAGNIFIER_WIDTH - 4, left));

  const borderColor = getBorderColor();

  return (
    <div
      style={{
        position: "fixed",
        left,
        top,
        width: MAGNIFIER_WIDTH,
        height: TOTAL_HEIGHT,
        pointerEvents: "none",
        zIndex: 9999,
        willChange: "transform",
        filter:
          "drop-shadow(0 1px 4px rgba(0, 0, 0, 0.18)) drop-shadow(0 4px 12px rgba(0, 0, 0, 0.12))",
      }}
    >
      {/* Outer shape acts as border */}
      <div
        style={{
          width: MAGNIFIER_WIDTH,
          height: TOTAL_HEIGHT,
          clipPath: `path('${buildLoupePath(MAGNIFIER_WIDTH, TOTAL_HEIGHT, 12, MAGNIFIER_POINTER_SIZE)}')`,
          background: borderColor,
        }}
      >
        {/* Inner content inset by border width */}
        <div
          style={{
            position: "absolute",
            top: 0.5,
            left: 0.5,
            width: MAGNIFIER_WIDTH - 1,
            height: TOTAL_HEIGHT - 0.5,
            clipPath: `path('${buildLoupePath(MAGNIFIER_WIDTH - 1, TOTAL_HEIGHT - 0.5, 11.5, MAGNIFIER_POINTER_SIZE - 0.5)}')`,
            overflow: "hidden",
          }}
        >
          <canvas
            ref={canvasRef}
            style={{
              width: MAGNIFIER_WIDTH - 1,
              height: MAGNIFIER_HEIGHT - 0.5,
              display: "block",
            }}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * Build an SVG path for the iOS-style loupe shape:
 * rounded rectangle with a small triangular pointer at bottom center.
 */
function buildLoupePath(
  w: number,
  h: number,
  r: number,
  pointerH: number,
): string {
  const bodyH = h - pointerH;
  const pw = pointerH * 1.4; // pointer half-width
  const cx = w / 2;

  return [
    `M ${r} 0`,
    `L ${w - r} 0`,
    `Q ${w} 0 ${w} ${r}`,
    `L ${w} ${bodyH - r}`,
    `Q ${w} ${bodyH} ${w - r} ${bodyH}`,
    `L ${cx + pw} ${bodyH}`,
    `L ${cx} ${h}`,
    `L ${cx - pw} ${bodyH}`,
    `L ${r} ${bodyH}`,
    `Q 0 ${bodyH} 0 ${bodyH - r}`,
    `L 0 ${r}`,
    `Q 0 0 ${r} 0`,
    `Z`,
  ].join(" ");
}

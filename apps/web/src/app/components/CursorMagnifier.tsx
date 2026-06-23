import { useEffect, useRef } from "react";

// Loupe geometry — owned entirely by the host. The engine knows nothing about a
// magnifier; it only emits the cursor-drag gesture (CURSOR_DRAG_* actions).
const MAGNIFIER_WIDTH = 168;
const MAGNIFIER_HEIGHT = 72;
const MAGNIFIER_RADIUS = 12; // rounded-rect corner radius
const MAGNIFIER_MIN_OFFSET_Y = 44; // minimum gap above the finger (fallback when no radius)

interface CursorMagnifierProps {
  /** Whether a cursor-drag gesture is active (CURSOR_DRAG_START..END). */
  active: boolean;
  /**
   * Live caret coords (viewport space, with scroll applied) — `editor.view
   * .coordsAtPos("caret")`. The loupe centers horizontally on the caret (iOS-
   * style: it glides along the line as the caret snaps) and zooms around it. Read
   * every frame, after the engine has committed the dragged caret move.
   */
  getCaretCoords: () => { x: number; y: number; height: number } | null;
  /**
   * Latest raw finger geometry from the CURSOR_DRAG_* payload. The loupe sits a
   * short gap above the finger: `touchY` is the vertical anchor and
   * `touchRadiusY` sizes the fingertip clearance.
   */
  getTouch: () => {
    touchX: number;
    touchY: number;
    touchRadiusX: number;
    touchRadiusY: number;
  };
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
 * Gap above the finger, sized from the finger's contact radius so the loupe
 * clears the fingertip. Falls back to a reasonable minimum when no radius is
 * reported.
 */
function computeOffsetY(touchRadiusY: number): number {
  if (touchRadiusY > 0) return touchRadiusY + 12;
  return MAGNIFIER_MIN_OFFSET_Y;
}

export function CursorMagnifier({
  active,
  getCaretCoords,
  getTouch,
  contentCanvas,
  cursorCanvas,
  containerRect,
}: CursorMagnifierProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number>(0);
  const getCaretCoordsRef = useRef(getCaretCoords);
  getCaretCoordsRef.current = getCaretCoords;
  const getTouchRef = useRef(getTouch);
  getTouchRef.current = getTouch;
  const containerRectRef = useRef(containerRect);
  containerRectRef.current = containerRect;

  useEffect(() => {
    if (!active || !contentCanvas) {
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
      const wrapper = wrapperRef.current;
      const rect = containerRectRef.current;
      // Pull the caret's live pixel location — resolved here (post-commit) so the
      // loupe tracks the current caret, anchored to the character being placed.
      const caret = getCaretCoordsRef.current();
      if (!wrapper || !rect || !caret) {
        rafRef.current = requestAnimationFrame(draw);
        return;
      }

      const touch = getTouchRef.current();

      // Body: horizontally centered on the caret (so it stays fixed to the
      // character), vertically anchored just above the finger so it sits a short,
      // constant gap from the thumb. Flips below when there's no room above;
      // clamped horizontally to the viewport.
      const fingerY = rect.top + touch.touchY;
      const offsetY = computeOffsetY(touch.touchRadiusY);
      let left = rect.left + caret.x - MAGNIFIER_WIDTH / 2;
      let top = fingerY - offsetY - MAGNIFIER_HEIGHT;
      if (top < 0) {
        top = fingerY + offsetY;
      }
      left = Math.max(
        4,
        Math.min(window.innerWidth - MAGNIFIER_WIDTH - 4, left),
      );
      wrapper.style.left = `${left}px`;
      wrapper.style.top = `${top}px`;

      const lineHeight = caret.height;
      const zoom = computeZoom(lineHeight);

      ctx.clearRect(0, 0, magnifierCanvas.width, magnifierCanvas.height);
      ctx.save();
      ctx.scale(dpr, dpr);

      // Fill with page background so transparent canvas areas have contrast
      ctx.fillStyle = getBackgroundColor();
      ctx.fillRect(0, 0, MAGNIFIER_WIDTH, MAGNIFIER_HEIGHT);

      // Source region: centered on the caret position in the content canvas
      const sourceWidth = MAGNIFIER_WIDTH / zoom;
      const sourceHeight = MAGNIFIER_HEIGHT / zoom;
      const sw = sourceWidth * dpr;
      const sh = sourceHeight * dpr;

      // Clamp source center so the view region never extends past
      // the canvas bounds (iOS-style: stops panning at edges)
      const cw = contentCanvas.width;
      const ch = contentCanvas.height;
      const cx = Math.max(sw / 2, Math.min(cw - sw / 2, caret.x * dpr));
      // caret.y is the top of the line; center on the cursor's vertical midpoint
      const cursorMidY = (caret.y + lineHeight / 2) * dpr;
      const cy = Math.max(sh / 2, Math.min(ch - sh / 2, cursorMidY));
      const sx = cx - sw / 2;
      const sy = cy - sh / 2;

      // Composite content layer
      ctx.drawImage(
        contentCanvas,
        sx,
        sy,
        sw,
        sh,
        0,
        0,
        MAGNIFIER_WIDTH,
        MAGNIFIER_HEIGHT,
      );

      // Composite cursor layer on top
      if (cursorCanvas) {
        ctx.drawImage(
          cursorCanvas,
          sx,
          sy,
          sw,
          sh,
          0,
          0,
          MAGNIFIER_WIDTH,
          MAGNIFIER_HEIGHT,
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
  }, [active, contentCanvas, cursorCanvas]);

  if (!active) return null;

  return (
    <div
      ref={wrapperRef}
      style={{
        position: "fixed",
        // Start off-screen; the RAF sets the real position before first paint.
        left: -9999,
        top: -9999,
        width: MAGNIFIER_WIDTH,
        height: MAGNIFIER_HEIGHT,
        pointerEvents: "none",
        zIndex: 9999,
        willChange: "transform",
        borderRadius: MAGNIFIER_RADIUS,
        border: `1px solid ${getBorderColor()}`,
        overflow: "hidden",
        filter:
          "drop-shadow(0 1px 4px rgba(0, 0, 0, 0.18)) drop-shadow(0 4px 12px rgba(0, 0, 0, 0.12))",
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          width: MAGNIFIER_WIDTH,
          height: MAGNIFIER_HEIGHT,
          display: "block",
        }}
      />
    </div>
  );
}

/**
 * Canvas Layer Management
 *
 * This module manages multiple stacked canvas layers for efficient rendering:
 * - Content Layer: Text, blocks, images, selection, scrollbar
 * - Cursor Layer: Just the blinking cursor
 *
 * By separating the cursor into its own layer, we avoid expensive full-page
 * re-renders every time the cursor blinks (every 530ms).
 */

import { invariant } from "@shared/invariant";

export interface CanvasLayers {
  content: {
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
  };
  cursor: {
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
  };
}

/**
 * Create layered canvases stacked on top of each other
 */
export function createCanvasLayers(
  container: HTMLElement,
  width: number,
  height: number,
): CanvasLayers {
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;

  const createLayer = (id: string, zIndex: number, pointerEvents: boolean) => {
    const canvas = document.createElement("canvas");
    canvas.id = id;
    canvas.style.position = "absolute";
    canvas.style.top = "0";
    canvas.style.left = "0";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.zIndex = zIndex.toString();
    canvas.style.pointerEvents = pointerEvents ? "auto" : "none";
    canvas.style.userSelect = "none";
    canvas.style.webkitUserSelect = "none";
    (
      canvas.style as unknown as { webkitTouchCallout?: string }
    ).webkitTouchCallout = "none";

    // Set display size (CSS pixels)
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    // Set actual size in memory (scaled for high DPI displays)
    canvas.width = width * dpr;
    canvas.height = height * dpr;

    const ctx = canvas.getContext("2d");
    invariant(ctx, "layers: failed to get a 2D context for layer %s", id);

    // Scale context to match DPR (so we can draw in CSS pixels)
    ctx.scale(dpr, dpr);

    container.appendChild(canvas);

    return { canvas, ctx };
  };

  return {
    // Bottom layer: content (text, blocks, images, selection)
    // This layer handles pointer events for mouse interaction
    content: createLayer("content-layer", 1, true),

    // Top layer: cursor (just the blinking cursor)
    // This layer is transparent and doesn't handle events
    cursor: createLayer("cursor-layer", 2, false),
  };
}

/**
 * Resize all canvas layers (e.g., when viewport changes)
 */
export function resizeCanvasLayers(
  layers: CanvasLayers,
  width: number,
  height: number,
) {
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;

  Object.values(layers).forEach(({ canvas, ctx }) => {
    // Update display size
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    // Update memory size (this automatically resets the canvas and clears transformations)
    canvas.width = width * dpr;
    canvas.height = height * dpr;

    // Apply DPR scaling to context
    // Note: Setting canvas.width/height above already reset the context,
    // so we don't need to manually reset the transformation matrix
    ctx.scale(dpr, dpr);
  });
}

/**
 * Clear a specific layer
 */
export function clearLayer(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
) {
  // Clear using the canvas dimensions (not CSS dimensions)
  // The DPR scaling is already applied to the context
  ctx.clearRect(0, 0, width, height);
}

/**
 * Destroy all canvas layers (cleanup)
 */
export function destroyCanvasLayers(layers: CanvasLayers) {
  Object.values(layers).forEach(({ canvas }) => {
    canvas.remove();
  });
}

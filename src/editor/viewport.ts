import { createInitialViewport } from "./state";
import type { ViewportState } from "./types";

export function resizeCanvas(
  ctx: CanvasRenderingContext2D,
  viewport: ViewportState | null
): ViewportState {
  const canvas = ctx.canvas;
  // look up the size the canvas is being displayed
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const viewportState = viewport || createInitialViewport(width, height);

  // adjust displayBuffer size to match
  if (ctx.canvas.width !== width || ctx.canvas.height !== height) {
    ctx.canvas.width = width;
    ctx.canvas.height = height;
    viewportState.width = width;
    viewportState.height = height;
  }

  return viewportState;
}

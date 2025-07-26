import type { ViewportState } from "./types";

export function resizeCanvas(
  ctx: CanvasRenderingContext2D,
  viewport: ViewportState
) {
  const canvas = ctx.canvas;
  // look up the size the canvas is being displayed
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;

  // adjust displayBuffer size to match
  if (viewport.width !== width || viewport.height !== height) {
    ctx.canvas.width = width;
    ctx.canvas.height = height;
    viewport.width = width;
    viewport.height = height;
  }
}

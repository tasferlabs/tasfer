import type { Page } from "../deserializer/loadPage";
import { handleEvents } from "./events";
import { renderPage } from "./renderer";
import { createInitialState, createInitialViewport } from "./state";
import type { EditorState, ViewportState } from "./types";
import { resizeCanvas as computeViewport } from "./viewport";

export interface Editor {
  start: (page: Page) => void;
  getState: () => EditorState;
  destroy: () => void;
}

export const createEditor = (canvas: HTMLCanvasElement): Editor => {
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Could not get 2D context from canvas");
  }

  let state: EditorState;
  let viewport: ViewportState;
  let animationFrameId: number | null = null;

  const eventsQueue: Event[] = [];

  // Render loop
  const render = () => {
    viewport = computeViewport(ctx, viewport);
    state = handleEvents(state, viewport, eventsQueue);
    renderPage(ctx, state, viewport);
    animationFrameId = requestAnimationFrame(render);
  };

  function eventsHandler(e: Event) {
    eventsQueue.push(e);
  }

  function start(page: Page) {
    viewport = createInitialViewport(ctx!.canvas.width, ctx!.canvas.height);
    state = createInitialState(page);
    render();

    canvas.addEventListener("mousedown", eventsHandler);
    canvas.addEventListener("mousemove", eventsHandler);
    canvas.addEventListener("mouseup", eventsHandler);
    window.addEventListener("keydown", eventsHandler);
    // canvas.addEventListener("wheel", eventsHandler);
  }

  function getState() {
    return state;
  }

  function destroy() {
    if (animationFrameId) {
      cancelAnimationFrame(animationFrameId);
    }

    canvas.removeEventListener("mousedown", eventsHandler);
    canvas.removeEventListener("mousemove", eventsHandler);
    canvas.removeEventListener("mouseup", eventsHandler);
    window.removeEventListener("keydown", eventsHandler);
    // canvas.removeEventListener("wheel", eventsHandler);
  }

  return {
    start,
    getState,
    destroy,
  };
};

// Export main function for use in main.ts
export { createEditor as default };

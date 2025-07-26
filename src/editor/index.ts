import type { Page } from "../deserializer/loadPage";
import { createEmptyCharacterMap } from "./characterMap";

import { handleEvents } from "./events";
import { renderPage } from "./renderer";
import { createInitialState } from "./state";
import type { EditorState } from "./types";
import { resizeCanvas } from "./utils";

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
  let animationFrameId: number | null = null;

  const eventsQueue: Event[] = [];

  // Render loop
  let characterMap = createEmptyCharacterMap({
    scrollY: 0,
    height: canvas.clientHeight,
    width: canvas.clientWidth,
  });
  const render = () => {
    resizeCanvas(ctx, state.viewport);
    state = handleEvents(state, eventsQueue, characterMap);
    const renderingState = renderPage(ctx, state);
    characterMap = renderingState.characterMap;
    animationFrameId = requestAnimationFrame(render);
  };

  function eventsHandler(e: Event) {
    eventsQueue.push(e);
  }

  function start(page: Page) {
    state = createInitialState(page, canvas.width, canvas.height);
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

import { loadPage, type Page } from "../deserializer/loadPage";
import { handleEvents } from "./events";
import { calculateBlockHeight, renderPage } from "./renderer";
import { createInitialState } from "./state";
import { defaultStyles } from "./styles";
import type { EditorState, ViewportState } from "./types";

export interface Editor {
  start: (setDocumentHeight: (height: number) => void) => void;
  getState: () => EditorState;
  destroy: () => void;
  load: (path: string) => Promise<void>;
  updateViewport: (viewport: Partial<ViewportState>) => void;
  getDocumentHeight: () => number;
}

export default function createEditor(canvas: HTMLCanvasElement): Editor {
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Could not get 2D context from canvas");
  }

  let page: Page;
  let state: EditorState;
  let viewport: ViewportState;
  let animationFrameId: number | null = null;
  let visibility = {
    start: 0,
    end: 0,
  };

  const eventsQueue: Event[] = [];

  // Render loop
  const render = (setDocumentHeight: (height: number) => void) => {
    state = handleEvents(state, viewport, visibility, eventsQueue);
    const documentHeight = renderPage(ctx, state, viewport, visibility);
    setDocumentHeight(documentHeight);
    animationFrameId = requestAnimationFrame(() => render(setDocumentHeight));
  };

  function eventsHandler(e: Event) {
    eventsQueue.push(e);
  }

  function start(setDocumentHeight: (height: number) => void) {
    if (!page) {
      throw new Error("Page not provided");
    }
    viewport = {
      scrollY: 0,
      width: canvas.width,
      height: canvas.height,
    };
    state = createInitialState(page);
    render(setDocumentHeight);

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

  async function load(path: string) {
    const response = await fetch(path);
    const content = await response.text();

    page = loadPage(content);
  }

  function updateViewport(newViewport: Partial<ViewportState>) {
    viewport = { ...viewport, ...newViewport };
  }

  function getDocumentHeight(): number {
    if (!page || !state) return 0;

    // Calculate total document height based on all blocks
    const styles = defaultStyles;
    const maxWidth = viewport.width - 2 * styles.canvas.paddingLeft;
    let totalHeight = styles.canvas.paddingTop;

    for (const block of page.blocks) {
      totalHeight += calculateBlockHeight(block, maxWidth, styles);
    }

    return totalHeight + styles.canvas.paddingBottom;
  }

  return {
    start,
    getState,
    destroy,
    load,
    updateViewport,
    getDocumentHeight,
  };
}
